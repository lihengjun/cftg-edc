import { deriveWebhookSecret } from './shared/utils.js';
import { t } from './i18n.js';
import { sendTelegramMessage, answerCallbackQuery } from './shared/telegram.js';
import { loadSystemConfig, runPasswordBackup } from './shared/storage.js';
import { cmdList, cmdSearch, handleEmailCallback, handleEmailReply, handleIncomingEmail } from './email/email.js';
import { cmdPwdList, cmdPwdSave, handlePwdCallback, handlePwdReply } from './password/password.js';
import { cmdConfig, handleConfigCallback, handleConfigReply, handleImportFile } from './config/config.js';

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

    // /init：设置 Webhook + Bot 命令菜单
    if (url.pathname === '/init') {
      await loadSystemConfig(env);
      const results = {};
      const secret = deriveWebhookSecret(env.TG_BOT_TOKEN);
      const workerUrl = `${url.origin}/`;

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
      // 清除默认 scope 的命令（别人看不到菜单）
      const delRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      results.deleteDefaultCommands = await delRes.json();

      // 仅对自己的 chat 设置命令菜单
      const cmdRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands,
          scope: { type: 'chat', chat_id: env.TG_CHAT_ID },
        }),
      });
      results.commands = await cmdRes.json();

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Email-to-Telegram worker is running.');
  },

  async email(message, env, ctx) {
    await loadSystemConfig(env);
    await handleIncomingEmail(message, env);
  },

  async scheduled(event, env, ctx) {
    await loadSystemConfig(env);
    const result = await runPasswordBackup(env);
    if (result.ok) {
      console.log(`Password backup: ${result.count} entries backed up (${result.date})`);
    }
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
