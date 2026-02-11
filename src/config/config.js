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
import { t, getLang, setLang } from '../i18n.js';

// ============ 配置项分类 ============

const MAIL_CONFIG_KEYS = CONFIG_ITEMS.filter(c => c.key !== 'maxPasswords').map(c => c.key);

// ============ 主页 UI ============

export function buildConfigText(env, storageInfo) {
  let text = t('cfg.title') + '\n';
  if (storageInfo) {
    text += '\n' + t('cfg.mail', { used: formatSize(storageInfo.used), total: formatSize(storageInfo.total) });
    text += '\n' + t('cfg.star', { used: formatSize(storageInfo.starUsed), total: formatSize(storageInfo.starTotal) });
  }
  const pwdVal = getEffectiveValue(env, 'maxPasswords');
  text += '\n' + t('cfg.pwdLimit', { v: pwdVal === 0 ? t('cfg.unlimited') : t('cfg.count', { n: pwdVal }) });
  return text;
}

export function buildConfigKeyboard() {
  return {
    inline_keyboard: [
      [{ text: t('cfg.btnMail'), callback_data: 'cfg_mail' }, { text: t('cfg.btnPwd'), callback_data: 'cfg_pwd' }],
      [{ text: t('cfg.btnLang'), callback_data: 'cfg_lang' }],
      [{ text: t('btn.back'), callback_data: 'back' }],
    ],
  };
}

// ============ 密码设置二级菜单 ============

export function buildPwdConfigKeyboard() {
  return {
    inline_keyboard: [
      [{ text: t('cfg.pwd.btnLimit'), callback_data: 'cfg_e:maxPasswords' }],
      [{ text: t('cfg.pwd.btnExport'), callback_data: 'cfg_ex' }, { text: t('cfg.pwd.btnImport'), callback_data: 'cfg_im' }, { text: t('cfg.pwd.btnBackup'), callback_data: 'cfg_bk' }],
      [{ text: t('cfg.pwd.btnBackCfg'), callback_data: 'cfg' }],
    ],
  };
}

// ============ 邮件设置二级菜单 ============

export function buildMailConfigText(env, storageInfo) {
  let text = t('cfg.mail.title');
  for (const item of CONFIG_ITEMS) {
    if (item.key === 'maxPasswords') continue;
    const val = getEffectiveValue(env, item.key);
    const unitStr = t(item.unit);
    text += `${t(item.label)}：${val} ${unitStr}`;
    if (item.desc) text += `（${t(item.desc)}）`;
    text += '\n';
  }
  if (storageInfo) {
    text += '\n' + t('cfg.mail', { used: formatSize(storageInfo.used), total: formatSize(storageInfo.total) });
    text += '\n' + t('cfg.star', { used: formatSize(storageInfo.starUsed), total: formatSize(storageInfo.starTotal) });
  }
  return text;
}

export function buildMailConfigKeyboard() {
  const mailItems = CONFIG_ITEMS.filter(c => c.key !== 'maxPasswords');
  const rows = [];
  for (let i = 0; i < mailItems.length; i += 2) {
    const row = [{ text: t(mailItems[i].label), callback_data: `cfg_e:${mailItems[i].key}` }];
    if (i + 1 < mailItems.length) {
      row.push({ text: t(mailItems[i + 1].label), callback_data: `cfg_e:${mailItems[i + 1].key}` });
    }
    rows.push(row);
  }
  rows.push([{ text: t('cfg.mail.btnReset'), callback_data: 'cfg_rst' }]);
  rows.push([{ text: t('cfg.mail.btnBackCfg'), callback_data: 'cfg' }]);
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
  const text = t('cfg.pwd.title') + '\n\n' + t('cfg.pwd.limit', { v: pwdVal === 0 ? t('cfg.unlimited') : t('cfg.count', { n: pwdVal }) });
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
      const text = t('cfg.export.empty');
      if (msgId) await editMessageText(env, msgId, text);
      else await sendTelegramMessage(env, text);
      return;
    }

    if (msgId) await editMessageText(env, msgId, t('cfg.export.exporting'));

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

    const modeLabel = { plain: t('cfg.export.modePlain'), auto: t('cfg.export.modeAuto'), password: t('cfg.export.modePassword') }[mode];
    const text = t('cfg.export.done', { n: entries.length, mode: modeLabel });
    if (msgId) await editMessageText(env, msgId, text);
    else await sendTelegramMessage(env, text);
  } catch (err) {
    console.error('Export error:', err);
    const text = t('cfg.export.failed', { err: err.message });
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
      await sendTelegramMessage(env, t('cfg.import.cantDownload'));
      return;
    }

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { await sendTelegramMessage(env, t('cfg.import.invalidJson')); return; }

    if (parsed.version !== 1) {
      await sendTelegramMessage(env, t('cfg.import.unsupportedVersion'));
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
        await sendTelegramMessage(env, t('cfg.import.decryptFailed'));
      }
    } else if (parsed.mode === 'password') {
      await env.KV.put('pwd_import_encrypted', JSON.stringify({ iv: parsed.iv, data: parsed.data, salt: parsed.salt, exportedAt: parsed.exportedAt, count: parsed.count }), { expirationTtl: 300 });
      await sendTelegramPrompt(env, t('cfg.import.promptPwd'));
    } else {
      await sendTelegramMessage(env, t('cfg.import.unknownMode'));
    }
  } catch (err) {
    console.error('Import file error:', err);
    await sendTelegramMessage(env, t('cfg.import.failed', { err: err.message }));
  }
}

async function decryptAndPreviewImport(env, password) {
  try {
    const raw = await env.KV.get('pwd_import_encrypted');
    if (!raw) {
      await sendTelegramMessage(env, t('cfg.import.expired'));
      return;
    }
    const encrypted = JSON.parse(raw);
    try {
      const decrypted = await decryptWithPassword(password, encrypted);
      const entries = JSON.parse(decrypted);
      await env.KV.delete('pwd_import_encrypted');
      await previewImport(env, entries, encrypted.exportedAt);
    } catch {
      await sendTelegramMessage(env, t('cfg.import.wrongPwd'));
      await sendTelegramPrompt(env, t('cfg.import.promptPwd'));
    }
  } catch (err) {
    console.error('Decrypt import error:', err);
    await sendTelegramMessage(env, t('cfg.import.decryptErr', { err: err.message }));
  }
}

async function previewImport(env, entries, exportedAt) {
  await env.KV.put('pwd_import_pending', JSON.stringify(entries), { expirationTtl: 300 });
  const currentList = await getPasswordList(env);
  const dateStr = exportedAt ? new Date(exportedAt).toISOString().replace('T', ' ').slice(0, 16) : t('cfg.import.unknownDate');
  const text = t('cfg.import.preview', { date: dateStr, n: entries.length, current: currentList.length });
  await sendTelegramMessage(env, text, null, {
    reply_markup: {
      inline_keyboard: [
        [{ text: t('cfg.import.btnConfirm'), callback_data: 'cfg_ic' }, { text: t('cfg.import.btnCancel'), callback_data: 'cfg_in' }],
      ],
    },
  });
}

async function confirmImport(env, msgId) {
  try {
    const raw = await env.KV.get('pwd_import_pending');
    if (!raw) {
      await editMessageText(env, msgId, t('cfg.import.confirmExpired'));
      return;
    }
    const entries = JSON.parse(raw);
    await replaceAllPasswords(env, entries);
    await clearImportState(env);
    await editMessageText(env, msgId, t('cfg.import.done', { n: entries.length }));
  } catch (err) {
    console.error('Confirm import error:', err);
    await editMessageText(env, msgId, t('cfg.import.confirmFailed', { err: err.message }));
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
    await editMessageText(env, msgId, t('cfg.backup.empty'), {
      inline_keyboard: [[{ text: t('btn.back'), callback_data: 'cfg_pwd' }]],
    });
    return;
  }
  const rows = [];
  for (const item of index.slice(0, 10)) {
    const d = item.date.slice(5); // MM-DD
    rows.push([{ text: t('cfg.backup.item', { date: d, n: item.count }), callback_data: `cfg_br:${item.date}` }]);
  }
  rows.push([{ text: t('btn.back'), callback_data: 'cfg_pwd' }]);
  await editMessageText(env, msgId, t('cfg.backup.title'), { inline_keyboard: rows });
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
      const display = item.key === 'maxPasswords' && current === 0 ? t('cfg.unlimited') : `${current}`;
      let promptText = t('cfg.prompt.setValue', { label: t(item.label) });
      if (item.desc) promptText += `${t(item.desc)}\n`;
      promptText += t('cfg.prompt.currentValue', { v: display, unit: t(item.unit), min: item.min, max: item.max }) + (item.key === 'maxPasswords' ? t('cfg.prompt.unlimitedHint') : '');
      await sendTelegramPrompt(env, promptText);
    }
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'cfg_rst') {
    toast = t('cfg.toast.confirmReset');
    await loadSystemConfig(env);
    const storageInfo = await getStorageInfo(env);
    let text = buildMailConfigText(env, storageInfo);
    text += t('cfg.confirmReset');
    const kb = buildMailConfigKeyboard();
    kb.inline_keyboard[kb.inline_keyboard.length - 2] = [
      { text: t('cfg.btnConfirmReset'), callback_data: 'cfg_rsta' },
      { text: t('btn.cancel'), callback_data: 'cfg_mail' },
    ];
    await editMessageText(env, msgId, text, kb);
  } else if (action === 'cfg_rsta') {
    await loadSystemConfig(env);
    const config = env._sysConfig || {};
    for (const key of MAIL_CONFIG_KEYS) delete config[key];
    await setSystemConfig(env, config);
    toast = t('cfg.toast.resetDone');
    await editToMailConfig(env, msgId);
  } else if (action === 'cfg_lang') {
    await loadSystemConfig(env);
    const config = env._sysConfig || {};
    config.lang = getLang() === 'zh' ? 'en' : 'zh';
    await setSystemConfig(env, config);
    setLang(config.lang);
    // 更新 bot 命令菜单语言
    const commands = [
      { command: 'list', description: t('cmd.list') },
      { command: 'search', description: t('cmd.search') },
      { command: 'pwd', description: t('cmd.pwd') },
      { command: 'config', description: t('cmd.config') },
    ];
    await fetchWithRetry(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands, scope: { type: 'chat', chat_id: env.TG_CHAT_ID } }) },
      'setMyCommands',
    );
    await editToConfig(env, msgId);
  } else if (action === 'cfg_ex') {
    await editMessageText(env, msgId, t('cfg.export.title'), {
      inline_keyboard: [
        [{ text: t('cfg.export.plain'), callback_data: 'cfg_xp' }],
        [{ text: t('cfg.export.auto'), callback_data: 'cfg_xa' }],
        [{ text: t('cfg.export.password'), callback_data: 'cfg_xk' }],
        [{ text: t('btn.back'), callback_data: 'cfg_pwd' }],
      ],
    });
  } else if (action === 'cfg_xp') {
    await exportPasswords(env, msgId, 'plain');
  } else if (action === 'cfg_xa') {
    await exportPasswords(env, msgId, 'auto');
  } else if (action === 'cfg_xk') {
    await editMessageText(env, msgId, t('cfg.export.preparing'));
    await sendTelegramPrompt(env, t('cfg.export.promptPwd'));
  } else if (action === 'cfg_im') {
    await env.KV.put('pwd_import_mode', 'waiting', { expirationTtl: 300 });
    await editMessageText(env, msgId, t('cfg.import.waiting'));
  } else if (action === 'cfg_ic') {
    await confirmImport(env, msgId);
  } else if (action === 'cfg_in') {
    await clearImportState(env);
    toast = t('cfg.import.cancelled');
    await editToPwdConfig(env, msgId);
  } else if (action === 'cfg_bk') {
    await showBackupList(env, msgId);
  } else if (action === 'cfg_br') {
    await editMessageText(env, msgId, t('cfg.backup.confirmRestore', { date: value }), {
      inline_keyboard: [
        [{ text: t('cfg.backup.btnConfirmRestore'), callback_data: `cfg_brc:${value}` }, { text: t('cfg.backup.btnCancel'), callback_data: 'cfg_bk' }],
      ],
    });
  } else if (action === 'cfg_brc') {
    const result = await restorePasswordBackup(env, value);
    if (result.ok) {
      toast = t('cfg.backup.restored', { n: result.count });
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
    // 匹配导出/导入密码提示（用 🔑 前缀）
    if (replyTo.text.startsWith('🔑')) {
      const isExport = replyTo.text.includes(t('cfg.export.promptPwd').replace('🔑 ', '').split('：')[0].split(':')[0]);
      await deleteMessage(env, msg.message_id);
      await deleteMessage(env, replyTo.message_id);
      if (isExport) {
        await exportPasswords(env, null, 'password', text.trim());
      } else {
        await decryptAndPreviewImport(env, text.trim());
      }
    } else {
      // 匹配配置项设置提示（用 ⚙️ 前缀）
      // 尝试匹配每个 CONFIG_ITEM 的 label
      let matchedItem = null;
      for (const item of CONFIG_ITEMS) {
        const label = t(item.label);
        if (replyTo.text.includes(label)) {
          matchedItem = item;
          break;
        }
      }
      if (matchedItem) {
        const num = parseInt(text);
        if (isNaN(num) || num < matchedItem.min || num > matchedItem.max) {
          await sendTelegramMessage(env, t('cfg.invalidValue', { min: matchedItem.min, max: matchedItem.max }));
        } else {
          await loadSystemConfig(env);
          const config = env._sysConfig || {};
          if (num === matchedItem.defaultVal) {
            delete config[matchedItem.key];
          } else {
            config[matchedItem.key] = num;
          }
          await setSystemConfig(env, config);
          env._sysConfig = config;
          const unitStr = t(matchedItem.unit);
          const display = matchedItem.key === 'maxPasswords' && num === 0 ? t('cfg.unlimited') : `${num} ${unitStr}`;
          await sendTelegramMessage(env, t('cfg.valueSet', { label: t(matchedItem.label), v: display }));
        }
      }
    }
  } catch (err) {
    console.error('Config reply error:', err);
    try { await sendTelegramMessage(env, t('error.exec', { err: err.message })); } catch {}
  }
}
