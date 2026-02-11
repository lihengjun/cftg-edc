import {
  CONFIG_ITEMS, setSystemConfig, getEffectiveValue,
  loadSystemConfig, getMaxStorage, getStarMaxStorage, runEmailCleanup,
  getPasswordList, getPasswordEntry,
  getBackupIndex, replaceAllPasswords, restorePasswordBackup,
} from '../shared/storage.js';
import {
  sendTelegramMessage, sendTelegramPrompt, fetchWithRetry,
  sendTelegramDocument, downloadTelegramFile,
  editMessageText, deleteMessage, answerCallbackQuery,
} from '../shared/telegram.js';
import {
  encryptData, decryptData, encryptWithPassword, decryptWithPassword,
} from '../shared/crypto.js';
import { formatSize } from '../shared/utils.js';

// ============ 配置项分类 ============

const MAIL_CONFIG_KEYS = CONFIG_ITEMS.filter(c => c.key !== 'maxPasswords').map(c => c.key);

// ============ 主页 UI ============

export function buildConfigText(env, storageInfo) {
  let text = '⚙️ <b>系统设置</b>\n';
  if (storageInfo) {
    text += `\n💾 邮件：${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
    text += `\n⭐ 收藏：${formatSize(storageInfo.starUsed)} / ${formatSize(storageInfo.starTotal)}`;
  }
  const pwdVal = getEffectiveValue(env, 'maxPasswords');
  text += `\n🔐 密码上限：${pwdVal === 0 ? '不限' : `${pwdVal} 条`}`;
  return text;
}

export function buildConfigKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📧 邮件设置', callback_data: 'cfg_mail' }, { text: '🔐 密码设置', callback_data: 'cfg_pwd' }],
      [{ text: '◀️ 返回', callback_data: 'back' }],
    ],
  };
}

// ============ 密码设置二级菜单 ============

export function buildPwdConfigKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔐 密码上限', callback_data: 'cfg_e:maxPasswords' }],
      [{ text: '📤 导出', callback_data: 'cfg_ex' }, { text: '📥 导入', callback_data: 'cfg_im' }, { text: '💾 备份', callback_data: 'cfg_bk' }],
      [{ text: '◀️ 返回设置', callback_data: 'cfg' }],
    ],
  };
}

// ============ 邮件设置二级菜单 ============

export function buildMailConfigText(env, storageInfo) {
  let text = '📧 <b>邮件设置</b>\n\n';
  for (const item of CONFIG_ITEMS) {
    if (item.key === 'maxPasswords') continue;
    const val = getEffectiveValue(env, item.key);
    text += `${item.label}：${val} ${item.unit}`;
    if (item.desc) text += `（${item.desc}）`;
    text += '\n';
  }
  if (storageInfo) {
    text += `\n💾 邮件：${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
    text += `\n⭐ 收藏：${formatSize(storageInfo.starUsed)} / ${formatSize(storageInfo.starTotal)}`;
  }
  return text;
}

export function buildMailConfigKeyboard() {
  const mailItems = CONFIG_ITEMS.filter(c => c.key !== 'maxPasswords');
  const rows = [];
  for (let i = 0; i < mailItems.length; i += 2) {
    const row = [{ text: mailItems[i].label, callback_data: `cfg_e:${mailItems[i].key}` }];
    if (i + 1 < mailItems.length) {
      row.push({ text: mailItems[i + 1].label, callback_data: `cfg_e:${mailItems[i + 1].key}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🔄 恢复默认', callback_data: 'cfg_rst' }]);
  rows.push([{ text: '◀️ 返回设置', callback_data: 'cfg' }]);
  return { inline_keyboard: rows };
}

// ============ 存储信息 ============

function calcStarredSize(entries) {
  let size = 0;
  for (const e of entries) {
    if (!e.starred) continue;
    size += e.textSize || 0;
    for (const img of (e.images || [])) size += img.size;
  }
  return size;
}

async function getStorageInfo(env) {
  const idx = await runEmailCleanup(env);
  return {
    used: idx.totalSize, total: getMaxStorage(env),
    starUsed: calcStarredSize(idx.entries), starTotal: getStarMaxStorage(env),
  };
}

// ============ 页面导航 ============

export async function editToConfig(env, msgId) {
  await loadSystemConfig(env);
  const storageInfo = await getStorageInfo(env);
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

async function editToMailConfig(env, msgId) {
  await loadSystemConfig(env);
  const storageInfo = await getStorageInfo(env);
  return editMessageText(env, msgId, buildMailConfigText(env, storageInfo), buildMailConfigKeyboard());
}

async function editToPwdConfig(env, msgId) {
  await loadSystemConfig(env);
  const pwdVal = getEffectiveValue(env, 'maxPasswords');
  const text = `🔐 <b>密码设置</b>\n\n密码上限：${pwdVal === 0 ? '不限' : `${pwdVal} 条`}`;
  return editMessageText(env, msgId, text, buildPwdConfigKeyboard());
}

export async function cmdConfig(env) {
  await loadSystemConfig(env);
  const storageInfo = await getStorageInfo(env);
  return sendTelegramMessage(env, buildConfigText(env, storageInfo), null, {
    reply_markup: buildConfigKeyboard(),
  });
}

// ============ 导出 ============

async function exportPasswords(env, msgId, mode, userPassword) {
  try {
    const list = await getPasswordList(env);
    if (list.length === 0) {
      const text = '❌ 密码列表为空，无法导出';
      if (msgId) await editMessageText(env, msgId, text);
      else await sendTelegramMessage(env, text);
      return;
    }

    if (msgId) await editMessageText(env, msgId, '📤 正在导出…');

    const entries = [];
    for (const item of list) {
      const entry = await getPasswordEntry(env, item.name);
      if (entry) {
        entries.push({ name: item.name, username: entry.username || '', password: entry.password || '', note: entry.note || '', totp: entry.totp || '' });
      }
    }

    const now = Date.now();
    const dateStr = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    let exportData;

    if (mode === 'plain') {
      exportData = { version: 1, mode: 'plain', exportedAt: now, count: entries.length, entries };
    } else if (mode === 'auto') {
      const encrypted = await encryptData(env, JSON.stringify(entries));
      exportData = { version: 1, mode: 'auto', exportedAt: now, count: entries.length, iv: encrypted.iv, data: encrypted.data };
    } else if (mode === 'password') {
      const encrypted = await encryptWithPassword(userPassword, JSON.stringify(entries));
      exportData = { version: 1, mode: 'password', exportedAt: now, count: entries.length, salt: encrypted.salt, iv: encrypted.iv, data: encrypted.data };
    }

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    await sendTelegramDocument(env, blob, `passwords_${dateStr}.json`);

    const modeLabel = { plain: '明文', auto: '自动加密', password: '密码加密' }[mode];
    const text = `✅ 已导出 ${entries.length} 条密码（${modeLabel}）`;
    if (msgId) await editMessageText(env, msgId, text);
    else await sendTelegramMessage(env, text);
  } catch (err) {
    console.error('Export error:', err);
    const text = `❌ 导出失败: ${err.message}`;
    if (msgId) await editMessageText(env, msgId, text);
    else await sendTelegramMessage(env, text);
  }
}

// ============ 导入 ============

export async function handleImportFile(msg, env) {
  try {
    await env.KV.delete('pwd_import_mode');
    const fileId = msg.document.file_id;
    const content = await downloadTelegramFile(env, fileId);
    if (!content) {
      await sendTelegramMessage(env, '❌ 无法下载文件');
      return;
    }

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { await sendTelegramMessage(env, '❌ 文件格式错误，请发送有效的 JSON 文件'); return; }

    if (parsed.version !== 1) {
      await sendTelegramMessage(env, '❌ 不支持的备份版本');
      return;
    }

    if (parsed.mode === 'plain') {
      await previewImport(env, parsed.entries, parsed.exportedAt);
    } else if (parsed.mode === 'auto') {
      try {
        const decrypted = await decryptData(env, { iv: parsed.iv, data: parsed.data });
        const entries = JSON.parse(decrypted);
        await previewImport(env, entries, parsed.exportedAt);
      } catch {
        await sendTelegramMessage(env, '❌ 解密失败，可能 PWD_KEY 不匹配');
      }
    } else if (parsed.mode === 'password') {
      await env.KV.put('pwd_import_encrypted', JSON.stringify({ iv: parsed.iv, data: parsed.data, salt: parsed.salt, exportedAt: parsed.exportedAt, count: parsed.count }), { expirationTtl: 300 });
      await sendTelegramPrompt(env, '🔑 请输入导入密码：');
    } else {
      await sendTelegramMessage(env, '❌ 未知的加密模式');
    }
  } catch (err) {
    console.error('Import file error:', err);
    await sendTelegramMessage(env, `❌ 导入失败: ${err.message}`);
  }
}

async function decryptAndPreviewImport(env, password) {
  try {
    const raw = await env.KV.get('pwd_import_encrypted');
    if (!raw) {
      await sendTelegramMessage(env, '❌ 导入数据已过期，请重新发送文件');
      return;
    }
    const encrypted = JSON.parse(raw);
    try {
      const decrypted = await decryptWithPassword(password, encrypted);
      const entries = JSON.parse(decrypted);
      await env.KV.delete('pwd_import_encrypted');
      await previewImport(env, entries, encrypted.exportedAt);
    } catch {
      await sendTelegramMessage(env, '❌ 密码错误，请重试');
      await sendTelegramPrompt(env, '🔑 请输入导入密码：');
    }
  } catch (err) {
    console.error('Decrypt import error:', err);
    await sendTelegramMessage(env, `❌ 解密失败: ${err.message}`);
  }
}

async function previewImport(env, entries, exportedAt) {
  await env.KV.put('pwd_import_pending', JSON.stringify(entries), { expirationTtl: 300 });
  const currentList = await getPasswordList(env);
  const dateStr = exportedAt ? new Date(exportedAt).toISOString().replace('T', ' ').slice(0, 16) : '未知';
  const text = `📥 导入预览\n\n备份时间：${dateStr}\n包含 ${entries.length} 条密码\n当前已有 ${currentList.length} 条密码\n\n⚠️ 确认后将完全替换现有数据`;
  await sendTelegramMessage(env, text, null, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ 确认替换', callback_data: 'cfg_ic' }, { text: '❌ 取消', callback_data: 'cfg_in' }],
      ],
    },
  });
}

async function confirmImport(env, msgId) {
  try {
    const raw = await env.KV.get('pwd_import_pending');
    if (!raw) {
      await editMessageText(env, msgId, '❌ 导入数据已过期，请重新发送文件');
      return;
    }
    const entries = JSON.parse(raw);
    await replaceAllPasswords(env, entries);
    await clearImportState(env);
    await editMessageText(env, msgId, `✅ 已导入 ${entries.length} 条密码`);
  } catch (err) {
    console.error('Confirm import error:', err);
    await editMessageText(env, msgId, `❌ 导入失败: ${err.message}`);
  }
}

async function clearImportState(env) {
  await Promise.all([
    env.KV.delete('pwd_import_mode'),
    env.KV.delete('pwd_import_pending'),
    env.KV.delete('pwd_import_encrypted'),
  ]);
}

// ============ 备份 UI ============

async function showBackupList(env, msgId) {
  const index = await getBackupIndex(env);
  if (index.length === 0) {
    await editMessageText(env, msgId, '💾 暂无备份\n\n备份由系统每日凌晨自动创建', {
      inline_keyboard: [[{ text: '◀️ 返回', callback_data: 'cfg_pwd' }]],
    });
    return;
  }
  const rows = [];
  for (const item of index.slice(0, 10)) {
    const d = item.date.slice(5); // MM-DD
    rows.push([{ text: `${d} (${item.count}条)`, callback_data: `cfg_br:${item.date}` }]);
  }
  rows.push([{ text: '◀️ 返回', callback_data: 'cfg_pwd' }]);
  await editMessageText(env, msgId, '💾 密码备份', { inline_keyboard: rows });
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
  } else if (action === 'cfg_pwd') {
    await editToPwdConfig(env, msgId);
  } else if (action === 'cfg_mail') {
    await editToMailConfig(env, msgId);
  } else if (action === 'cfg_e') {
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
    await loadSystemConfig(env);
    const storageInfo = await getStorageInfo(env);
    let text = buildMailConfigText(env, storageInfo);
    text += '\n\n⚠️ 确认要恢复邮件设置为默认值吗？';
    const kb = buildMailConfigKeyboard();
    kb.inline_keyboard[kb.inline_keyboard.length - 2] = [
      { text: '⚠️ 确认恢复', callback_data: 'cfg_rsta' },
      { text: '取消', callback_data: 'cfg_mail' },
    ];
    await editMessageText(env, msgId, text, kb);
  } else if (action === 'cfg_rsta') {
    await loadSystemConfig(env);
    const config = env._sysConfig || {};
    for (const key of MAIL_CONFIG_KEYS) delete config[key];
    await setSystemConfig(env, config);
    toast = '✅ 已恢复邮件设置为默认值';
    await editToMailConfig(env, msgId);
  } else if (action === 'cfg_ex') {
    await editMessageText(env, msgId, '📤 选择导出模式：', {
      inline_keyboard: [
        [{ text: '📄 明文导出', callback_data: 'cfg_xp' }],
        [{ text: '🔒 加密导出(自动)', callback_data: 'cfg_xa' }],
        [{ text: '🔑 加密导出(密码)', callback_data: 'cfg_xk' }],
        [{ text: '◀️ 返回', callback_data: 'cfg_pwd' }],
      ],
    });
  } else if (action === 'cfg_xp') {
    await exportPasswords(env, msgId, 'plain');
  } else if (action === 'cfg_xa') {
    await exportPasswords(env, msgId, 'auto');
  } else if (action === 'cfg_xk') {
    await editMessageText(env, msgId, '📤 正在准备加密导出…');
    await sendTelegramPrompt(env, '🔑 请输入导出密码：');
  } else if (action === 'cfg_im') {
    await env.KV.put('pwd_import_mode', 'waiting', { expirationTtl: 300 });
    await editMessageText(env, msgId, '📥 请在5分钟内发送密码备份文件（.json）\n\n⚠️ 导入将完全替换现有所有密码数据');
  } else if (action === 'cfg_ic') {
    await confirmImport(env, msgId);
  } else if (action === 'cfg_in') {
    await clearImportState(env);
    toast = '已取消导入';
    await editToPwdConfig(env, msgId);
  } else if (action === 'cfg_bk') {
    await showBackupList(env, msgId);
  } else if (action === 'cfg_br') {
    await editMessageText(env, msgId, `⚠️ 确认要恢复 ${value} 的备份吗？\n\n这将完全替换现有所有密码数据`, {
      inline_keyboard: [
        [{ text: '✅ 确认恢复', callback_data: `cfg_brc:${value}` }, { text: '❌ 取消', callback_data: 'cfg_bk' }],
      ],
    });
  } else if (action === 'cfg_brc') {
    const result = await restorePasswordBackup(env, value);
    if (result.ok) {
      toast = `✅ 已恢复 ${result.count} 条密码`;
    } else {
      toast = `❌ ${result.error}`;
    }
    await editToPwdConfig(env, msgId);
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

// ============ handleConfigReply ============

export async function handleConfigReply(msg, replyTo, text, env) {
  try {
    if (replyTo.text.startsWith('🔑 请输入导出密码')) {
      await deleteMessage(env, msg.message_id);
      await deleteMessage(env, replyTo.message_id);
      await exportPasswords(env, null, 'password', text.trim());
    } else if (replyTo.text.startsWith('🔑 请输入导入密码')) {
      await deleteMessage(env, msg.message_id);
      await deleteMessage(env, replyTo.message_id);
      await decryptAndPreviewImport(env, text.trim());
    } else {
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
    }
  } catch (err) {
    console.error('Config reply error:', err);
    try { await sendTelegramMessage(env, `❌ 执行出错: ${err.message}`); } catch {}
  }
}
