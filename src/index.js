import { deriveWebhookSecret } from './shared/utils.js';
import { t } from './i18n.js';
import { sendTelegramMessage, answerCallbackQuery } from './shared/telegram.js';
import { loadSystemConfig, runPasswordBackup } from './shared/storage.js';
import { cmdList, cmdSearch, handleEmailCallback, handleEmailReply, handleIncomingEmail } from './email/email.js';
import { cmdPwdList, cmdPwdSave, handlePwdCallback, handlePwdReply } from './password/password.js';
import { cmdConfig, handleConfigCallback, handleConfigReply, handleImportFile } from './config/config.js';
import { VERSION, SCHEMA_VERSION } from './version.js';

// ============ 回调 action 前缀集合 ============

const PWD_ACTIONS = new Set([
  'pa', 'pv', 'ps', 'ph', 'pe', 'peu', 'pep', 'pen', 'prn', 'pet',
  'pt', 'pd', 'pcd', 'pp', 'pb', 'noop',
  'ptl', 'ptv', 'ptr', 'ptd', 'ptcd', 'ptp', 'ptca', 'ptcca',
]);

const CONFIG_ACTIONS = new Set([
  'cfg', 'cfg_e', 'cfg_rst', 'cfg_rsta', 'cfg_mail', 'cfg_pwd',
  'cfg_ex', 'cfg_xp', 'cfg_xa', 'cfg_xk', 'cfg_im', 'cfg_ic', 'cfg_in',
  'cfg_bk', 'cfg_br', 'cfg_brc', 'cfg_lang',
]);

// ============ Webhook 路由 ============

export async function handleTelegramWebhook(request, env, ctx) {
  let update;
  try { update = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }
  await loadSystemConfig(env);

  // 处理 Inline Keyboard 按钮回调
  const cbq = update.callback_query;
  if (cbq) {
    if (String(cbq.message?.chat?.id) !== String(env.TG_CHAT_ID)) return new Response('OK');
    try {
      const [action] = cbq.data.split(':');
      if (PWD_ACTIONS.has(action)) {
        await handlePwdCallback(cbq, env, ctx);
      } else if (CONFIG_ACTIONS.has(action)) {
        await handleConfigCallback(cbq, env);
      } else {
        await handleEmailCallback(cbq, env, ctx);
      }
    } catch (err) {
      console.error('Callback error:', err);
      await answerCallbackQuery(env, cbq.id, t('index.callbackError'));
    }
    return new Response('OK');
  }

  const msg = update.message;
  if (!msg) return new Response('OK');

  // 处理文件上传（密码导入）
  if (msg.document) {
    const chatId = String(msg.chat.id);
    if (chatId !== String(env.TG_CHAT_ID)) return new Response('OK');
    try {
      const importMode = await env.KV.get('pwd_import_mode');
      if (importMode === 'waiting') {
        await handleImportFile(msg, env);
      }
    } catch (err) {
      console.error('Document handling error:', err);
    }
    return new Response('OK');
  }

  if (!msg.text) return new Response('OK');

  // 安全验证：只响应配置的 chat_id
  const chatId = String(msg.chat.id);
  if (chatId !== String(env.TG_CHAT_ID)) {
    console.log(`Webhook: unauthorized chat_id ${chatId}`);
    return new Response('OK');
  }

  const text = msg.text.trim();

  // 处理用户回复 ForceReply 提示的输入（命令优先）
  const replyTo = msg.reply_to_message;
  if (replyTo && replyTo.text && !text.startsWith('/')) {
    if (replyTo.text.startsWith('⚙️') || replyTo.text.startsWith('🔑')) {
      await handleConfigReply(msg, replyTo, text, env);
    } else if (replyTo.text.startsWith('🔐')) {
      await handlePwdReply(msg, replyTo, text, env);
    } else {
      await handleEmailReply(msg, replyTo, text, env);
    }
    return new Response('OK');
  }

  const [rawCommand] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  try {
    switch (command) {
      case '/list': await cmdList(env); break;
      case '/pwd': await cmdPwdList(env); break;
      case '/save': {
        const pwdName = text.slice(rawCommand.length).trim();
        await cmdPwdSave(pwdName, env);
        break;
      }
      case '/search': {
        const keyword = text.slice(rawCommand.length).trim();
        await cmdSearch(keyword, env);
        break;
      }
      case '/config': await cmdConfig(env); break;
      default: return new Response('OK');
    }
  } catch (err) {
    console.error(`Webhook command error: ${command}`, err);
    try { await sendTelegramMessage(env, t('index.commandError', { err: err.message })); } catch {}
  }
  return new Response('OK');
}

// ============ 初始化（Webhook + 命令菜单） ============

async function runInit(origin, env) {
  await loadSystemConfig(env);
  const results = {};
  const secret = deriveWebhookSecret(env.TG_BOT_TOKEN);
  const workerUrl = `${origin}/`;

  const whRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: workerUrl, secret_token: secret }),
  });
  results.webhook = await whRes.json();

  const commands = [
    { command: 'list', description: t('cmd.list') },
    { command: 'search', description: t('cmd.search') },
    { command: 'pwd', description: t('cmd.pwd') },
    { command: 'config', description: t('cmd.config') },
  ];
  const delRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  results.deleteDefaultCommands = await delRes.json();

  const cmdRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands,
      scope: { type: 'chat', chat_id: env.TG_CHAT_ID },
    }),
  });
  results.commands = await cmdRes.json();

  if (results.webhook.ok && results.commands.ok) {
    await env.KV.put('sys_initialized', Date.now().toString());
    await env.KV.put('sys_schema_version', String(SCHEMA_VERSION));
  }

  return results;
}

// ============ 健康检查 ============

async function buildHealthPage(env) {
  await loadSystemConfig(env);
  const lines = [t('health.title', { version: VERSION })];

  // 检查 secrets
  const missingSecrets = [];
  if (!env.TG_BOT_TOKEN) missingSecrets.push('TG_BOT_TOKEN');
  if (!env.TG_CHAT_ID) missingSecrets.push('TG_CHAT_ID');

  if (missingSecrets.length > 0) {
    for (const name of missingSecrets) {
      lines.push(t('health.secretMissing', { name }));
    }
    return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  lines.push(t('health.status'));

  // Bot 连接 + Webhook 状态（并行请求，3 秒超时）
  const [botResult, webhookResult] = await Promise.allSettled([
    fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json()),
    fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json()),
  ]);

  if (botResult.status === 'fulfilled' && botResult.value.ok) {
    lines.push(t('health.bot', { username: botResult.value.result.username }));
  } else {
    lines.push(t('health.botFail'));
  }

  if (webhookResult.status === 'fulfilled' && webhookResult.value.ok && webhookResult.value.result.url) {
    lines.push(t('health.webhook'));
  } else if (webhookResult.status === 'fulfilled') {
    lines.push(t('health.webhookNot'));
  } else {
    lines.push(t('health.webhookFail'));
  }

  // KV 连接
  try {
    await env.KV.get('sys_initialized');
    lines.push(t('health.kv'));
  } catch {
    lines.push(t('health.kvFail'));
  }

  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ============ 版本检查 ============

async function checkLatestVersion(env) {
  try {
    const res = await fetch('https://api.github.com/repos/lihengjun/cftg-edc/releases/latest', {
      headers: { 'User-Agent': 'cftg-edc', 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (tag) {
      await env.KV.put('sys_latest_version', tag);
    }
  } catch {
    // 静默失败，不影响任何功能
  }
}

// ============ Worker 入口 ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook POST：验证 secret_token
    if (request.method === 'POST') {
      const secret = deriveWebhookSecret(env.TG_BOT_TOKEN);
      const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (headerSecret !== secret) {
        return new Response('Unauthorized', { status: 403 });
      }
      return handleTelegramWebhook(request, env, ctx);
    }

    // /init：手动触发设置 Webhook + Bot 命令菜单
    if (url.pathname === '/init') {
      const results = await runInit(url.origin, env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 首次访问自动初始化
    const initialized = await env.KV.get('sys_initialized');
    if (!initialized) {
      try { await runInit(url.origin, env); } catch {}
    }

    return buildHealthPage(env);
  },

  async email(message, env, ctx) {
    await loadSystemConfig(env);
    await handleIncomingEmail(message, env);
  },

  async scheduled(event, env, ctx) {
    await loadSystemConfig(env);

    // 确保 schema 版本号存在
    const schemaVer = await env.KV.get('sys_schema_version');
    if (!schemaVer) {
      await env.KV.put('sys_schema_version', String(SCHEMA_VERSION));
    }

    const result = await runPasswordBackup(env);
    if (result.ok) {
      console.log(`Password backup: ${result.count} entries backed up (${result.date})`);
    }

    // 检查最新版本（静默，不影响其他功能）
    ctx.waitUntil(checkLatestVersion(env));
  },
};

// ============ 重新导出所有模块（测试兼容） ============

export * from './shared/utils.js';
export * from './shared/telegram.js';
export * from './shared/crypto.js';
export * from './email/encoding.js';
export * from './shared/storage.js';
export * from './email/email.js';
export * from './config/config.js';
export * from './password/password.js';
export * from './i18n.js';
export * from './version.js';
