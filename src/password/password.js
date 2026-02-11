import { esc } from '../shared/utils.js';
import { t } from '../i18n.js';
import {
  sleep, sendTelegramMessage, sendTelegramPrompt,
  editMessageText, deleteMessage, answerCallbackQuery,
} from '../shared/telegram.js';
import { generateTOTP, parseTotpInput } from '../shared/crypto.js';
import {
  getPasswordList, setPasswordList, getPasswordEntry, setPasswordEntry,
  deletePasswordEntry, resolvePwdName,
  getTrashList, setTrashList, deleteTrashEntry, getTrashEntry,
  moveToTrash, cleanExpiredTrash, restoreFromTrash,
  PWD_TRASH_TTL, getMaxPasswords,
} from '../shared/storage.js';

export const PWD_PAGE_SIZE = 8;

export function cbData(prefix, name) {
  const enc = new TextEncoder();
  if (enc.encode(prefix + name).length <= 64) return prefix + name;
  let n = name;
  while (enc.encode(prefix + n).length > 64) n = n.slice(0, -1);
  return prefix + n;
}

export function buildPwdListText(list, page) {
  const total = list.length;
  if (total === 0) return t('pwd.list.empty');
  const totalPages = Math.ceil(total / PWD_PAGE_SIZE);
  let text = t('pwd.list.title', { n: total });
  if (totalPages > 1) text += t('pwd.list.page', { page: page + 1, pages: totalPages });
  return text;
}

export function buildPwdListKeyboard(list, page, trashCount) {
  const rows = [];
  const totalPages = Math.ceil(list.length / PWD_PAGE_SIZE) || 1;
  const start = page * PWD_PAGE_SIZE;
  const pageItems = list.slice(start, start + PWD_PAGE_SIZE);
  for (const item of pageItems) {
    rows.push([{ text: item.name, callback_data: cbData('pv:', item.name) }]);
  }
  if (page === 0) {
    const actionRow = [{ text: t('pwd.list.btnNew'), callback_data: 'pa' }];
    actionRow.push(trashCount > 0
      ? { text: t('pwd.list.btnTrashCount', { n: trashCount }), callback_data: 'ptl' }
      : { text: t('pwd.list.btnTrash'), callback_data: 'ptl' });
    rows.push(actionRow);
  }
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0) navRow.push({ text: '◀️', callback_data: `pp:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) navRow.push({ text: '▶️', callback_data: `pp:${page + 1}` });
    rows.push(navRow);
  }
  return { inline_keyboard: rows };
}

export function buildPwdDetailText(name, entry, showPassword) {
  let text = `🔐 <b>${esc(name)}</b>\n`;
  if (entry.username) {
    text += `\n👤 <code>${esc(entry.username)}</code>\n`;
  }
  if (entry.password) {
    if (showPassword) {
      text += `\n🔑 <code>${esc(entry.password)}</code>\n`;
    } else {
      text += `\n🔑 ••••••••••\n`;
    }
  }
  if (entry.note) {
    text += `\n📝 ${esc(entry.note)}\n`;
  }
  if (entry.totp) {
    text += t('pwd.detail.totp');
  }
  if (showPassword && entry.password) {
    text += t('pwd.detail.autoHide');
  }
  return text;
}

export function buildPwdDetailKeyboard(name, showPassword, confirmDel, hasPassword, hasTotp) {
  const rows = [];
  const row1 = [];
  if (hasPassword) {
    if (showPassword) {
      row1.push({ text: t('pwd.detail.btnHide'), callback_data: cbData('ph:', name) });
    } else {
      row1.push({ text: t('pwd.detail.btnShow'), callback_data: cbData('ps:', name) });
    }
  }
  row1.push({ text: t('pwd.detail.btnEdit'), callback_data: cbData('pe:', name) });
  if (confirmDel) {
    rows.push(row1);
    rows.push([
      { text: t('pwd.detail.btnConfirmDel'), callback_data: cbData('pcd:', name) },
      { text: t('btn.cancel'), callback_data: cbData('pv:', name) },
    ]);
  } else {
    row1.push({ text: t('pwd.detail.btnDel'), callback_data: cbData('pd:', name) });
    rows.push(row1);
  }
  if (hasTotp) {
    rows.push([{ text: t('pwd.detail.btnTotp'), callback_data: cbData('pt:', name) }]);
  }
  rows.push([{ text: t('pwd.list.btnBackList'), callback_data: 'pb' }]);
  return { inline_keyboard: rows };
}

export function buildPwdEditKeyboard(name) {
  const rows = [];
  rows.push([
    { text: t('pwd.edit.btnUsername'), callback_data: cbData('peu:', name) },
    { text: t('pwd.edit.btnPassword'), callback_data: cbData('pep:', name) },
  ]);
  rows.push([
    { text: t('pwd.edit.btnNote'), callback_data: cbData('pen:', name) },
    { text: t('pwd.edit.btnTotp'), callback_data: cbData('pet:', name) },
  ]);
  rows.push([{ text: t('pwd.edit.btnName'), callback_data: cbData('prn:', name) }]);
  rows.push([{ text: t('pwd.edit.btnBack'), callback_data: cbData('pv:', name) }]);
  return { inline_keyboard: rows };
}

// ============ 回收站 UI ============

export function buildTrashListText(trashList, page) {
  const total = trashList.length;
  if (total === 0) return t('pwd.trash.empty');
  const totalPages = Math.ceil(total / PWD_PAGE_SIZE);
  let text = t('pwd.trash.title', { n: total });
  if (totalPages > 1) text += t('pwd.trash.page', { page: page + 1, pages: totalPages });
  return text;
}

export function buildTrashListKeyboard(trashList, page, confirmClearAll) {
  const rows = [];
  const totalPages = Math.ceil(trashList.length / PWD_PAGE_SIZE) || 1;
  const start = page * PWD_PAGE_SIZE;
  const pageItems = trashList.slice(start, start + PWD_PAGE_SIZE);
  for (const item of pageItems) {
    const remain = Math.max(0, Math.ceil((PWD_TRASH_TTL - (Date.now() - item.deletedAt)) / (24 * 60 * 60 * 1000)));
    rows.push([{ text: `${item.name}（${t('pwd.trash.remain', { n: remain })}）`, callback_data: `ptv:${item.deletedAt}` }]);
  }
  const bottomRow = [];
  if (totalPages > 1) {
    if (page > 0) bottomRow.push({ text: '◀️', callback_data: `ptp:${page - 1}` });
    bottomRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) bottomRow.push({ text: '▶️', callback_data: `ptp:${page + 1}` });
  }
  if (trashList.length > 0) {
    if (confirmClearAll) {
      rows.push([
        { text: t('pwd.trash.btnConfirmClearAll'), callback_data: 'ptcca' },
        { text: t('btn.cancel'), callback_data: 'ptl' },
      ]);
    } else {
      bottomRow.push({ text: t('pwd.trash.btnClear'), callback_data: 'ptca' });
    }
  }
  if (bottomRow.length) rows.push(bottomRow);
  rows.push([{ text: t('pwd.trash.btnBackPwd'), callback_data: 'pb' }]);
  return { inline_keyboard: rows };
}

export function buildTrashDetailText(name, entry, deletedAt) {
  const remain = Math.max(0, Math.ceil((PWD_TRASH_TTL - (Date.now() - deletedAt)) / (24 * 60 * 60 * 1000)));
  let text = `🗑 <b>${esc(name)}</b>\n`;
  text += t('pwd.trash.remainDetail', { n: remain });
  if (entry.username) text += `\n👤 <code>${esc(entry.username)}</code>\n`;
  if (entry.password) text += `\n🔑 ••••••••••\n`;
  if (entry.note) text += `\n📝 ${esc(entry.note)}\n`;
  return text;
}

export function buildTrashDetailKeyboard(deletedAt, confirmDel) {
  const rows = [];
  if (confirmDel) {
    rows.push([
      { text: t('pwd.trash.btnConfirmPermDel'), callback_data: `ptcd:${deletedAt}` },
      { text: t('btn.cancel'), callback_data: `ptv:${deletedAt}` },
    ]);
  } else {
    rows.push([
      { text: t('pwd.trash.btnRestore'), callback_data: `ptr:${deletedAt}` },
      { text: t('pwd.trash.btnPermDel'), callback_data: `ptd:${deletedAt}` },
    ]);
  }
  rows.push([{ text: t('pwd.trash.btnBackTrash'), callback_data: 'ptl' }]);
  return { inline_keyboard: rows };
}

async function editToTrashList(env, msgId, page, confirmClearAll) {
  if (page === undefined) page = 0;
  await cleanExpiredTrash(env);
  const trashList = await getTrashList(env);
  return editMessageText(env, msgId, buildTrashListText(trashList, page), buildTrashListKeyboard(trashList, page, confirmClearAll));
}

async function editToTrashDetail(env, msgId, deletedAt, confirmDel) {
  const trashList = await getTrashList(env);
  const item = trashList.find(t => t.deletedAt === deletedAt);
  if (!item) return editMessageText(env, msgId, t('pwd.trash.notExist'));
  const entry = await getTrashEntry(env, deletedAt);
  if (!entry) return editMessageText(env, msgId, t('pwd.trash.dataLost'));
  return editMessageText(env, msgId, buildTrashDetailText(item.name, entry, deletedAt), buildTrashDetailKeyboard(deletedAt, confirmDel));
}

async function deduplicateList(env) {
  const list = await getPasswordList(env);
  const seen = new Set();
  let dirty = false;
  const clean = [];
  for (const item of list) {
    if (seen.has(item.name)) { dirty = true; continue; }
    seen.add(item.name);
    clean.push(item);
  }
  if (dirty) await setPasswordList(env, clean);
  return clean;
}

export async function editToPwdList(env, msgId, page) {
  if (page === undefined) page = 0;
  const [list, trashList] = await Promise.all([getPasswordList(env), getTrashList(env)]);
  list.sort((a, b) => b.ts - a.ts);
  return editMessageText(env, msgId, buildPwdListText(list, page), buildPwdListKeyboard(list, page, trashList.length));
}

export async function editToPwdDetail(env, msgId, name, showPassword, confirmDel) {
  const entry = await getPasswordEntry(env, name);
  if (!entry) {
    return editMessageText(env, msgId, t('pwd.detail.notExist', { name: esc(name) }));
  }
  return editMessageText(env, msgId, buildPwdDetailText(name, entry, showPassword), buildPwdDetailKeyboard(name, showPassword, confirmDel, !!entry.password, !!entry.totp));
}

export async function editToPwdEdit(env, msgId, name) {
  return editMessageText(env, msgId, t('pwd.edit.title', { name: esc(name) }), buildPwdEditKeyboard(name));
}

export async function cmdPwdList(env) {
  const [list, trashList] = await Promise.all([deduplicateList(env), getTrashList(env)]);
  list.sort((a, b) => b.ts - a.ts);
  const result = await sendTelegramMessage(env, buildPwdListText(list, 0), null, {
    reply_markup: buildPwdListKeyboard(list, 0, trashList.length),
  });
  if (!result?.ok) {
    console.error('cmdPwdList failed:', JSON.stringify(result));
    const errDesc = result?.description || 'unknown';
    await sendTelegramMessage(env, buildPwdListText(list, 0) + t('pwd.kbFailed') + esc(errDesc));
  }
}

export async function cmdPwdSave(name, env) {
  if (!name) {
    await sendTelegramPrompt(env, t('pwd.prompt.name'));
    return;
  }
  const cleanName = name.split('\n')[0].trim();
  if (!cleanName || cleanName.includes(':') || new TextEncoder().encode(cleanName).length > 60) {
    await sendTelegramMessage(env, t('pwd.invalidName'));
    return;
  }
  name = cleanName;
  const maxPwd = getMaxPasswords(env);
  if (maxPwd > 0) {
    const currentList = await getPasswordList(env);
    if (currentList.length >= maxPwd) {
      await sendTelegramMessage(env, t('pwd.limitReached', { n: maxPwd }));
      return;
    }
  }
  const existingEntry = await getPasswordEntry(env, name);
  if (existingEntry) {
    await sendTelegramMessage(env, t('pwd.alreadyExists') + buildPwdDetailText(name, existingEntry, false), null, {
      reply_markup: buildPwdDetailKeyboard(name, false, false, !!existingEntry.password, !!existingEntry.totp),
    });
    return;
  }
  const entry = { username: '', password: '', note: '', totp: '' };
  await setPasswordEntry(env, name, entry, { overwrite: false });
  const list = await getPasswordList(env);
  list.unshift({ name, ts: Date.now() });
  await setPasswordList(env, list);
  const text = buildPwdDetailText(name, entry, false) + t('pwd.editHint');
  await sendTelegramMessage(env, text, null, {
    reply_markup: buildPwdDetailKeyboard(name, false, false, false),
  });
}

export async function handlePwdCallback(cbq, env, ctx) {
  const data = cbq.data;
  const [action, ...rest] = data.split(':');
  const value = rest.join(':');
  const msgId = cbq.message.message_id;
  let toast = '';

  if (action === 'pa') {
    await sendTelegramPrompt(env, t('pwd.prompt.name'));
  } else if (action === 'pv') {
    const name = await resolvePwdName(env, value);
    await editToPwdDetail(env, msgId, name, false);
  } else if (action === 'ps') {
    const name = await resolvePwdName(env, value);
    await editToPwdDetail(env, msgId, name, true);
    if (ctx) {
      ctx.waitUntil(
        sleep(30000).then(() => editToPwdDetail(env, msgId, name, false).catch(() => {}))
      );
    }
  } else if (action === 'ph') {
    const name = await resolvePwdName(env, value);
    await editToPwdDetail(env, msgId, name, false);
  } else if (action === 'pe') {
    const name = await resolvePwdName(env, value);
    await editToPwdEdit(env, msgId, name);
  } else if (action === 'peu' || action === 'pep' || action === 'pen' || action === 'prn' || action === 'pet') {
    const name = await resolvePwdName(env, value);
    const entry = await getPasswordEntry(env, name);
    const fieldMap = { peu: ['username', entry?.username], pep: ['password', entry?.password], pen: ['note', entry?.note], prn: ['name', name], pet: ['totp', entry?.totp] };
    const [fieldKey, current] = fieldMap[action];
    const field = t(`pwd.field.${fieldKey}`);
    let prompt = t('pwd.prompt.edit', { name: esc(name), field });
    if (action === 'pet') {
      prompt += t('pwd.prompt.totpHint');
      if (current) prompt += t('pwd.prompt.clearHint');
    } else if (current) {
      prompt += t('pwd.prompt.currentValue', { v: esc(current) });
    }
    await sendTelegramPrompt(env, prompt);
  } else if (action === 'pt') {
    const name = await resolvePwdName(env, value);
    const entry = await getPasswordEntry(env, name);
    if (!entry?.totp) {
      toast = t('pwd.noTotp');
    } else {
      try {
        const code = await generateTOTP(entry.totp);
        const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
        const result = await sendTelegramMessage(env, t('pwd.totpResult', { code, sec: remaining }));
        if (result?.result?.message_id && ctx) {
          ctx.waitUntil(
            sleep(remaining * 1000).then(() => deleteMessage(env, result.result.message_id).catch(() => {}))
          );
        }
      } catch (err) {
        toast = t('pwd.totpFailed');
        console.error('TOTP error:', err);
      }
    }
  } else if (action === 'pd') {
    const name = await resolvePwdName(env, value);
    await editToPwdDetail(env, msgId, name, false, true);
    toast = t('pwd.toast.confirmDel', { name });
  } else if (action === 'pcd') {
    const name = await resolvePwdName(env, value);
    const result = await moveToTrash(env, name);
    toast = result ? t('pwd.toast.trashed') : t('pwd.toast.notExist');
    await editToPwdList(env, msgId);
  } else if (action === 'pp') {
    await editToPwdList(env, msgId, parseInt(value));
  } else if (action === 'pb') {
    await editToPwdList(env, msgId);
  } else if (action === 'ptl') {
    await editToTrashList(env, msgId);
  } else if (action === 'ptv') {
    await editToTrashDetail(env, msgId, parseInt(value));
  } else if (action === 'ptr') {
    const result = await restoreFromTrash(env, parseInt(value));
    if (result.ok) {
      toast = result.wasRenamed ? t('pwd.toast.restoredRenamed', { name: result.name }) : t('pwd.toast.restored', { name: result.name });
      await editToPwdList(env, msgId);
    } else {
      toast = `❌ ${result.error}`;
    }
  } else if (action === 'ptd') {
    await editToTrashDetail(env, msgId, parseInt(value), true);
    toast = t('pwd.trash.toast.confirmPermDel');
  } else if (action === 'ptcd') {
    const ts = parseInt(value);
    const trashList = await getTrashList(env);
    const item = trashList.find(t => t.deletedAt === ts);
    const name = item?.name || 'unknown';
    await deleteTrashEntry(env, ts);
    const tidx = trashList.findIndex(ti => ti.deletedAt === ts);
    if (tidx !== -1) trashList.splice(tidx, 1);
    await setTrashList(env, trashList);
    toast = t('pwd.trash.toast.permDeleted', { name });
    await editToTrashList(env, msgId);
  } else if (action === 'ptp') {
    await editToTrashList(env, msgId, parseInt(value));
  } else if (action === 'ptca') {
    await editToTrashList(env, msgId, 0, true);
    toast = t('pwd.trash.toast.confirmClearAll');
  } else if (action === 'ptcca') {
    const trashList = await getTrashList(env);
    await Promise.all(trashList.map(item => deleteTrashEntry(env, item.deletedAt)));
    await setTrashList(env, []);
    toast = t('pwd.trash.toast.cleared');
    await editToTrashList(env, msgId);
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

export async function handlePwdReply(msg, replyTo, text, env) {
  try {
    // 匹配 "🔐 请输入密码名称" / "🔐 Enter password name"
    const namePrompt = t('pwd.prompt.name');
    if (replyTo.text.startsWith(namePrompt.slice(0, 4))) {
      // 检查是否是新建密码提示（不包含编辑关键字）
      // 编辑提示包含字段名，新建提示不包含
      if (!replyTo.text.includes(t('pwd.field.username')) && !replyTo.text.includes(t('pwd.field.password'))
        && !replyTo.text.includes(t('pwd.field.note')) && !replyTo.text.includes(t('pwd.field.name'))
        && !replyTo.text.includes(t('pwd.field.totp'))) {
        const name = text.split('\n')[0].trim();
        await deleteMessage(env, replyTo.message_id);
        await cmdPwdSave(name, env);
        return;
      }
      // 解析编辑字段：匹配 "🔐 编辑 NAME FIELD：" 或 "🔐 Edit NAME FIELD:"
      const fieldKeys = ['username', 'password', 'note', 'name', 'totp'];
      let matchedName = null;
      let matchedFieldKey = null;
      for (const fk of fieldKeys) {
        const fieldLabel = t(`pwd.field.${fk}`);
        if (replyTo.text.includes(fieldLabel)) {
          matchedFieldKey = fk;
          // 用模板标记提取名称（语言无关）
          const marker = '\x01';
          const tpl = t('pwd.prompt.edit', { name: marker, field: fieldLabel });
          const mi = tpl.indexOf(marker);
          if (mi !== -1) {
            const prefix = tpl.slice(0, mi);
            const suffix = tpl.slice(mi + 1);
            if (replyTo.text.startsWith(prefix)) {
              const si = replyTo.text.indexOf(suffix, prefix.length);
              if (si !== -1) matchedName = replyTo.text.slice(prefix.length, si).trim();
            }
          }
          break;
        }
      }
      if (!matchedName || !matchedFieldKey) {
        await sendTelegramMessage(env, t('pwd.reply.cantParse'));
      } else {
        const newValue = text.trim();
        const entry = await getPasswordEntry(env, matchedName);
        if (!entry) {
          await sendTelegramMessage(env, t('pwd.reply.notExist', { name: esc(matchedName) }));
        } else if (matchedFieldKey === 'name') {
          if (!newValue || newValue.includes(':') || new TextEncoder().encode(newValue).length > 60) {
            await sendTelegramMessage(env, t('pwd.invalidName'));
          } else if (newValue !== matchedName && await getPasswordEntry(env, newValue)) {
            await sendTelegramMessage(env, t('pwd.reply.nameExists', { name: esc(newValue) }));
          } else {
            await setPasswordEntry(env, newValue, entry, { overwrite: newValue === matchedName });
            await deletePasswordEntry(env, matchedName);
            const list = await getPasswordList(env);
            const idx = list.findIndex(e => e.name === matchedName);
            if (idx !== -1) list[idx].name = newValue;
            await setPasswordList(env, list);
            await deleteMessage(env, msg.message_id);
            await deleteMessage(env, replyTo.message_id);
            const rtext = t('pwd.reply.renamed') + buildPwdDetailText(newValue, entry, false);
            await sendTelegramMessage(env, rtext, null, {
              reply_markup: buildPwdDetailKeyboard(newValue, false, false, !!entry.password, !!entry.totp),
            });
          }
        } else if (matchedFieldKey === 'totp') {
          if (!newValue || !newValue.trim()) {
            entry.totp = '';
            await setPasswordEntry(env, matchedName, entry);
            await deleteMessage(env, msg.message_id);
            await deleteMessage(env, replyTo.message_id);
            const rtext = t('pwd.reply.totpCleared') + buildPwdDetailText(matchedName, entry, false);
            await sendTelegramMessage(env, rtext, null, {
              reply_markup: buildPwdDetailKeyboard(matchedName, false, false, !!entry.password, !!entry.totp),
            });
          } else {
            const secret = parseTotpInput(newValue);
            if (!secret) {
              await sendTelegramMessage(env, t('pwd.reply.invalidTotp'));
            } else {
              entry.totp = secret;
              await setPasswordEntry(env, matchedName, entry);
              await deleteMessage(env, msg.message_id);
              await deleteMessage(env, replyTo.message_id);
              const rtext = t('pwd.reply.totpSet') + buildPwdDetailText(matchedName, entry, false);
              await sendTelegramMessage(env, rtext, null, {
                reply_markup: buildPwdDetailKeyboard(matchedName, false, false, !!entry.password, !!entry.totp),
              });
            }
          }
        } else {
          if (matchedFieldKey === 'username') entry.username = newValue;
          else if (matchedFieldKey === 'password') entry.password = newValue;
          else if (matchedFieldKey === 'note') entry.note = newValue;
          await setPasswordEntry(env, matchedName, entry);
          await deleteMessage(env, msg.message_id);
          await deleteMessage(env, replyTo.message_id);
          const rtext = t('pwd.reply.updated', { field: t(`pwd.field.${matchedFieldKey}`) }) + buildPwdDetailText(matchedName, entry, false);
          await sendTelegramMessage(env, rtext, null, {
            reply_markup: buildPwdDetailKeyboard(matchedName, false, false, !!entry.password, !!entry.totp),
          });
        }
      }
    }
  } catch (err) {
    console.error('Password reply error:', err);
    try { await sendTelegramMessage(env, t('error.exec', { err: err.message })); } catch {}
  }
}
