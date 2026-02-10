import {
  CONFIG_ITEMS, setSystemConfig, getEffectiveValue,
  loadSystemConfig, getMaxStorage, getStarMaxStorage, runEmailCleanup,
} from '../shared/storage.js';
import {
  sendTelegramMessage, sendTelegramPrompt, fetchWithRetry,
  editMessageText, answerCallbackQuery,
} from '../shared/telegram.js';
import { formatSize } from '../shared/utils.js';

// ============ 配置页 UI ============

export function buildConfigText(env, storageInfo) {
  let text = '⚙️ <b>系统设置</b>\n\n';
  for (const item of CONFIG_ITEMS) {
    const val = getEffectiveValue(env, item.key);
    const display = item.key === 'maxPasswords' && val === 0 ? '不限' : `${val} ${item.unit}`;
    text += `${item.label}：${display}`;
    if (item.desc) text += `（${item.desc}）`;
    text += '\n';
  }
  if (storageInfo) {
    text += `\n💾 邮件：${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
    text += `\n⭐ 收藏：${formatSize(storageInfo.starUsed)} / ${formatSize(storageInfo.starTotal)}`;
  }
  return text;
}

export function buildConfigKeyboard() {
  const rows = [];
  // 每行两个按钮
  for (let i = 0; i < CONFIG_ITEMS.length; i += 2) {
    const row = [{ text: CONFIG_ITEMS[i].label, callback_data: `cfg_e:${CONFIG_ITEMS[i].key}` }];
    if (i + 1 < CONFIG_ITEMS.length) {
      row.push({ text: CONFIG_ITEMS[i + 1].label, callback_data: `cfg_e:${CONFIG_ITEMS[i + 1].key}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🔄 恢复默认', callback_data: 'cfg_rst' }]);
  rows.push([{ text: '◀️ 返回', callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

function calcStarredSize(entries) {
  let size = 0;
  for (const e of entries) {
    if (!e.starred) continue;
    size += e.textSize || 0;
    for (const img of (e.images || [])) size += img.size;
  }
  return size;
}

export async function editToConfig(env, msgId) {
  await loadSystemConfig(env);
  const idx = await runEmailCleanup(env);
  const storageInfo = {
    used: idx.totalSize, total: getMaxStorage(env),
    starUsed: calcStarredSize(idx.entries), starTotal: getStarMaxStorage(env),
  };
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text: buildConfigText(env, storageInfo),
    parse_mode: 'HTML',
    reply_markup: buildConfigKeyboard(),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editToConfig',
  );
}

export async function cmdConfig(env) {
  await loadSystemConfig(env);
  const idx = await runEmailCleanup(env);
  const storageInfo = {
    used: idx.totalSize, total: getMaxStorage(env),
    starUsed: calcStarredSize(idx.entries), starTotal: getStarMaxStorage(env),
  };
  return sendTelegramMessage(env, buildConfigText(env, storageInfo), null, {
    reply_markup: buildConfigKeyboard(),
  });
}

// ============ handleConfigCallback ============

export async function handleConfigCallback(cbq, env) {
  const data = cbq.data;
  const msgId = cbq.message.message_id;
  const [action, ...rest] = data.split(':');
  const value = rest.join(':');
  let toast = '';

  if (action === 'cfg') {
    await editToConfig(env, msgId);
  } else if (action === 'cfg_e') {
    // value = config key
    const item = CONFIG_ITEMS.find(c => c.key === value);
    if (item) {
      await loadSystemConfig(env);
      const current = getEffectiveValue(env, value);
      const display = item.key === 'maxPasswords' && current === 0 ? '不限' : `${current}`;
      let promptText = `⚙️ 设置${item.label}\n`;
      if (item.desc) promptText += `${item.desc}\n`;
      promptText += `\n当前值：${display} ${item.unit}\n有效范围：${item.min}-${item.max}${item.key === 'maxPasswords' ? '（0=不限）' : ''}`;
      await sendTelegramPrompt(env, promptText);
    }
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'cfg_rst') {
    toast = '⚠️ 再次点击确认恢复默认';
    // 编辑为带确认按钮的配置页
    await loadSystemConfig(env);
    const idx = await runEmailCleanup(env);
    const storageInfo = {
      used: idx.totalSize, total: getMaxStorage(env),
      starUsed: calcStarredSize(idx.entries), starTotal: getStarMaxStorage(env),
    };
    let text = buildConfigText(env, storageInfo);
    text += '\n\n⚠️ 确认要恢复所有配置为默认值吗？';
    const kb = buildConfigKeyboard();
    // 替换恢复默认按钮为确认/取消
    kb.inline_keyboard[kb.inline_keyboard.length - 2] = [
      { text: '⚠️ 确认恢复', callback_data: 'cfg_rsta' },
      { text: '取消', callback_data: 'cfg' },
    ];
    await editMessageText(env, msgId, text, kb);
  } else if (action === 'cfg_rsta') {
    await setSystemConfig(env, {});
    toast = '✅ 已恢复默认设置';
    await editToConfig(env, msgId);
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

// ============ handleConfigReply ============

export async function handleConfigReply(msg, replyTo, text, env) {
  try {
    const keyMatch = replyTo.text.match(/⚙️ 设置(.+)\n/);
    if (keyMatch) {
      const matchLabel = keyMatch[1];
      const item = CONFIG_ITEMS.find(c => c.label === matchLabel);
      if (item) {
        const num = parseInt(text);
        if (isNaN(num) || num < item.min || num > item.max) {
          await sendTelegramMessage(env, `❌ 无效值，请输入 ${item.min}-${item.max} 的整数`);
        } else {
          await loadSystemConfig(env);
          const config = env._sysConfig || {};
          if (num === item.defaultVal) {
            delete config[item.key];
          } else {
            config[item.key] = num;
          }
          await setSystemConfig(env, config);
          env._sysConfig = config;
          const display = item.key === 'maxPasswords' && num === 0 ? '不限' : `${num} ${item.unit}`;
          await sendTelegramMessage(env, `✅ ${item.label}已设为 ${display}`);
        }
      }
    }
  } catch (err) {
    console.error('Config reply error:', err);
    try { await sendTelegramMessage(env, `❌ 执行出错: ${err.message}`); } catch {}
  }
}
