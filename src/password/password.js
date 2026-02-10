import { esc } from '../shared/utils.js';
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
  if (total === 0) return '🔐 密码列表为空\n\n点击下方 ➕ 新建';
  const totalPages = Math.ceil(total / PWD_PAGE_SIZE);
  let text = `🔐 密码列表（${total} 条）`;
  if (totalPages > 1) text += ` 第 ${page + 1}/${totalPages} 页`;
  return text;
}

export function buildPwdListKeyboard(list, page, trashCount) {
  const rows = [];
  const totalPages = Math.ceil(list.length / PWD_PAGE_SIZE) || 1;
  const isLastPage = page >= totalPages - 1;
  const start = page * PWD_PAGE_SIZE;
  const pageItems = list.slice(start, start + PWD_PAGE_SIZE);
  for (const item of pageItems) {
    rows.push([{ text: item.name, callback_data: cbData('pv:', item.name) }]);
  }
  const bottomRow = [];
  if (page === 0) {
    bottomRow.push({ text: '➕ 新建', callback_data: 'pa' });
  }
  if (totalPages > 1) {
    if (page > 0) bottomRow.push({ text: '◀️', callback_data: `pp:${page - 1}` });
    bottomRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) bottomRow.push({ text: '▶️', callback_data: `pp:${page + 1}` });
  }
  if (isLastPage && trashCount > 0) {
    bottomRow.push({ text: `🗑 (${trashCount})`, callback_data: 'ptl' });
  }
  if (bottomRow.length) rows.push(bottomRow);
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
    text += `\n🔢 2FA 已启用\n`;
  }
  if (showPassword && entry.password) {
    text += `\n⏱ 30秒后自动隐藏`;
  }
  return text;
}

export function buildPwdDetailKeyboard(name, showPassword, confirmDel, hasPassword, hasTotp) {
  const rows = [];
  const row1 = [];
  if (hasPassword) {
    if (showPassword) {
      row1.push({ text: '🙈 隐藏', callback_data: cbData('ph:', name) });
    } else {
      row1.push({ text: '👁 显示密码', callback_data: cbData('ps:', name) });
    }
  }
  row1.push({ text: '✏️ 编辑', callback_data: cbData('pe:', name) });
  if (confirmDel) {
    rows.push(row1);
    rows.push([
      { text: `⚠️ 确认删除`, callback_data: cbData('pcd:', name) },
      { text: '取消', callback_data: cbData('pv:', name) },
    ]);
  } else {
    row1.push({ text: '🗑 删除', callback_data: cbData('pd:', name) });
    rows.push(row1);
  }
  if (hasTotp) {
    rows.push([{ text: '🔢 获取验证码', callback_data: cbData('pt:', name) }]);
  }
  rows.push([{ text: '◀️ 返回列表', callback_data: 'pb' }]);
  return { inline_keyboard: rows };
}

export function buildPwdEditKeyboard(name) {
  const rows = [];
  rows.push([
    { text: '👤 用户名', callback_data: cbData('peu:', name) },
    { text: '🔑 密码', callback_data: cbData('pep:', name) },
  ]);
  rows.push([
    { text: '📝 备注', callback_data: cbData('pen:', name) },
    { text: '🔢 2FA密钥', callback_data: cbData('pet:', name) },
  ]);
  rows.push([{ text: '📛 名称', callback_data: cbData('prn:', name) }]);
  rows.push([{ text: '◀️ 返回', callback_data: cbData('pv:', name) }]);
  return { inline_keyboard: rows };
}

// ============ 回收站 UI ============

export function buildTrashListText(trashList, page) {
  const total = trashList.length;
  if (total === 0) return '🗑 回收站为空';
  const totalPages = Math.ceil(total / PWD_PAGE_SIZE);
  let text = `🗑 回收站（${total} 条）`;
  if (totalPages > 1) text += ` 第 ${page + 1}/${totalPages} 页`;
  return text;
}

export function buildTrashListKeyboard(trashList, page, confirmClearAll) {
  const rows = [];
  const totalPages = Math.ceil(trashList.length / PWD_PAGE_SIZE) || 1;
  const start = page * PWD_PAGE_SIZE;
  const pageItems = trashList.slice(start, start + PWD_PAGE_SIZE);
  for (const item of pageItems) {
    const remain = Math.max(0, Math.ceil((PWD_TRASH_TTL - (Date.now() - item.deletedAt)) / (24 * 60 * 60 * 1000)));
    rows.push([{ text: `${item.name}（${remain}天）`, callback_data: `ptv:${item.deletedAt}` }]);
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
        { text: '⚠️ 确认清空全部', callback_data: 'ptcca' },
        { text: '取消', callback_data: 'ptl' },
      ]);
    } else {
      bottomRow.push({ text: '🗑 清空', callback_data: 'ptca' });
    }
  }
  if (bottomRow.length) rows.push(bottomRow);
  rows.push([{ text: '◀️ 返回密码列表', callback_data: 'pb' }]);
  return { inline_keyboard: rows };
}

export function buildTrashDetailText(name, entry, deletedAt) {
  const remain = Math.max(0, Math.ceil((PWD_TRASH_TTL - (Date.now() - deletedAt)) / (24 * 60 * 60 * 1000)));
  let text = `🗑 <b>${esc(name)}</b>\n`;
  text += `\n🕐 剩余 ${remain} 天自动清除\n`;
  if (entry.username) text += `\n👤 <code>${esc(entry.username)}</code>\n`;
  if (entry.password) text += `\n🔑 ••••••••••\n`;
  if (entry.note) text += `\n📝 ${esc(entry.note)}\n`;
  return text;
}

export function buildTrashDetailKeyboard(deletedAt, confirmDel) {
  const rows = [];
  if (confirmDel) {
    rows.push([
      { text: '⚠️ 确认永久删除', callback_data: `ptcd:${deletedAt}` },
      { text: '取消', callback_data: `ptv:${deletedAt}` },
    ]);
  } else {
    rows.push([
      { text: '♻️ 恢复', callback_data: `ptr:${deletedAt}` },
      { text: '❌ 永久删除', callback_data: `ptd:${deletedAt}` },
    ]);
  }
  rows.push([{ text: '◀️ 返回回收站', callback_data: 'ptl' }]);
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
  if (!item) return editMessageText(env, msgId, '❌ 回收站条目不存在');
  const entry = await getTrashEntry(env, deletedAt);
  if (!entry) return editMessageText(env, msgId, '❌ 条目数据已丢失');
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
    return editMessageText(env, msgId, `❌ 密码 <b>${esc(name)}</b> 不存在`);
  }
  return editMessageText(env, msgId, buildPwdDetailText(name, entry, showPassword), buildPwdDetailKeyboard(name, showPassword, confirmDel, !!entry.password, !!entry.totp));
}

export async function editToPwdEdit(env, msgId, name) {
  return editMessageText(env, msgId, `✏️ 编辑 <b>${esc(name)}</b>：\n\n选择要修改的字段：`, buildPwdEditKeyboard(name));
}

export async function cmdPwdList(env) {
  const [list, trashList] = await Promise.all([deduplicateList(env), getTrashList(env)]);
  list.sort((a, b) => b.ts - a.ts);
  const result = await sendTelegramMessage(env, buildPwdListText(list, 0), null, {
    reply_markup: buildPwdListKeyboard(list, 0, trashList.length),
  });
  if (!result?.ok) {
    console.error('cmdPwdList failed:', JSON.stringify(result));
    // 降级：不带键盘发送，附带错误信息
    const errDesc = result?.description || 'unknown';
    await sendTelegramMessage(env, buildPwdListText(list, 0) + `\n\n⚠️ 键盘加载失败: ${esc(errDesc)}`);
  }
}

export async function cmdPwdSave(name, env) {
  if (!name) {
    await sendTelegramPrompt(env, '🔐 请输入密码名称：');
    return;
  }
  const cleanName = name.split('\n')[0].trim();
  if (!cleanName || cleanName.includes(':') || new TextEncoder().encode(cleanName).length > 60) {
    await sendTelegramMessage(env, '❌ 名称不能为空、不能包含 : 且不超过60字节');
    return;
  }
  name = cleanName;
  // 检查密码条数限制
  const maxPwd = getMaxPasswords(env);
  if (maxPwd > 0) {
    const currentList = await getPasswordList(env);
    if (currentList.length >= maxPwd) {
      await sendTelegramMessage(env, `❌ 已达密码上限（${maxPwd} 条），请删除旧条目后再添加`);
      return;
    }
  }
  // 已存在则直接显示详情，不覆盖
  const existingEntry = await getPasswordEntry(env, name);
  if (existingEntry) {
    await sendTelegramMessage(env, `⚠️ 该名称已存在，已跳转到对应条目\n\n` + buildPwdDetailText(name, existingEntry, false), null, {
      reply_markup: buildPwdDetailKeyboard(name, false, false, !!existingEntry.password, !!existingEntry.totp),
    });
    return;
  }
  // 创建空条目
  const entry = { username: '', password: '', note: '', totp: '' };
  await setPasswordEntry(env, name, entry, { overwrite: false });
  const list = await getPasswordList(env);
  list.unshift({ name, ts: Date.now() });
  await setPasswordList(env, list);
  const text = buildPwdDetailText(name, entry, false) + '\n\n💡 点击下方编辑按钮逐项填写';
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
    await sendTelegramPrompt(env, '🔐 请输入密码名称：');
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
    const fieldMap = { peu: ['用户名', entry?.username], pep: ['密码', entry?.password], pen: ['备注', entry?.note], prn: ['名称', name], pet: ['2FA密钥', entry?.totp] };
    const [field, current] = fieldMap[action];
    let prompt = `🔐 编辑 ${esc(name)} 的${field}：`;
    if (action === 'pet') {
      prompt += '\n\n请输入 Base32 密钥或 otpauth:// URI';
      if (current) prompt += '\n（发送空格可清除）';
    } else if (current) {
      prompt += `\n\n当前值：<code>${esc(current)}</code>\n点击上方可复制，修改后发送`;
    }
    await sendTelegramPrompt(env, prompt);
  } else if (action === 'pt') {
    const name = await resolvePwdName(env, value);
    const entry = await getPasswordEntry(env, name);
    if (!entry?.totp) {
      toast = '未设置2FA密钥';
    } else {
      try {
        const code = await generateTOTP(entry.totp);
        const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
        const result = await sendTelegramMessage(env, `🔢 <code>${code}</code>\n\n⏱ ${remaining}秒后过期并删除`);
        if (result?.result?.message_id && ctx) {
          ctx.waitUntil(
            sleep(remaining * 1000).then(() => deleteMessage(env, result.result.message_id).catch(() => {}))
          );
        }
      } catch (err) {
        toast = '❌ 生成验证码失败';
        console.error('TOTP error:', err);
      }
    }
  } else if (action === 'pd') {
    const name = await resolvePwdName(env, value);
    await editToPwdDetail(env, msgId, name, false, true);
    toast = `确认要删除 ${name} 吗？`;
  } else if (action === 'pcd') {
    const name = await resolvePwdName(env, value);
    const result = await moveToTrash(env, name);
    toast = result ? '🗑 已移至回收站' : '❌ 条目不存在';
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
      toast = result.wasRenamed ? `♻️ 已恢复为 ${result.name}` : `♻️ 已恢复 ${result.name}`;
      await editToPwdList(env, msgId);
    } else {
      toast = `❌ ${result.error}`;
    }
  } else if (action === 'ptd') {
    await editToTrashDetail(env, msgId, parseInt(value), true);
    toast = '确认要永久删除吗？';
  } else if (action === 'ptcd') {
    const ts = parseInt(value);
    const trashList = await getTrashList(env);
    const item = trashList.find(t => t.deletedAt === ts);
    const name = item?.name || '未知';
    await deleteTrashEntry(env, ts);
    const idx = trashList.findIndex(t => t.deletedAt === ts);
    if (idx !== -1) trashList.splice(idx, 1);
    await setTrashList(env, trashList);
    toast = `❌ 已永久删除 ${name}`;
    await editToTrashList(env, msgId);
  } else if (action === 'ptp') {
    await editToTrashList(env, msgId, parseInt(value));
  } else if (action === 'ptca') {
    await editToTrashList(env, msgId, 0, true);
    toast = '确认要清空全部吗？';
  } else if (action === 'ptcca') {
    const trashList = await getTrashList(env);
    await Promise.all(trashList.map(item => deleteTrashEntry(env, item.deletedAt)));
    await setTrashList(env, []);
    toast = '🗑 已清空回收站';
    await editToTrashList(env, msgId);
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

export async function handlePwdReply(msg, replyTo, text, env) {
  try {
    if (replyTo.text.startsWith('🔐 请输入密码名称')) {
      const name = text.split('\n')[0].trim();
      await deleteMessage(env, replyTo.message_id);
      await cmdPwdSave(name, env);
    } else if (replyTo.text.startsWith('🔐 编辑 ')) {
      const editMatch = replyTo.text.match(/🔐 编辑 (.+?) 的(用户名|密码|备注|名称|2FA密钥)：/);
      if (!editMatch) {
        await sendTelegramMessage(env, '❌ 无法识别编辑指令，请重新点击编辑按钮');
      } else {
        const name = editMatch[1];
        const field = editMatch[2];
        const newValue = text.trim();
        const entry = await getPasswordEntry(env, name);
        if (!entry) {
          await sendTelegramMessage(env, `❌ 密码 <b>${esc(name)}</b> 不存在`);
        } else if (field === '名称') {
          if (!newValue || newValue.includes(':') || new TextEncoder().encode(newValue).length > 60) {
            await sendTelegramMessage(env, '❌ 名称不能为空、不能包含 : 且不超过60字节');
          } else if (newValue !== name && await getPasswordEntry(env, newValue)) {
            await sendTelegramMessage(env, `❌ 名称 <b>${esc(newValue)}</b> 已存在，请换一个`);
          } else {
            await setPasswordEntry(env, newValue, entry, { overwrite: newValue === name });
            await deletePasswordEntry(env, name);
            const list = await getPasswordList(env);
            const idx = list.findIndex(e => e.name === name);
            if (idx !== -1) list[idx].name = newValue;
            await setPasswordList(env, list);
            await deleteMessage(env, msg.message_id);
            await deleteMessage(env, replyTo.message_id);
            const text = `✅ 已重命名\n\n` + buildPwdDetailText(newValue, entry, false);
            await sendTelegramMessage(env, text, null, {
              reply_markup: buildPwdDetailKeyboard(newValue, false, false, !!entry.password, !!entry.totp),
            });
          }
        } else if (field === '2FA密钥') {
          if (!newValue || !newValue.trim()) {
            entry.totp = '';
            await setPasswordEntry(env, name, entry);
            await deleteMessage(env, msg.message_id);
            await deleteMessage(env, replyTo.message_id);
            const text = `✅ 已清除2FA\n\n` + buildPwdDetailText(name, entry, false);
            await sendTelegramMessage(env, text, null, {
              reply_markup: buildPwdDetailKeyboard(name, false, false, !!entry.password, !!entry.totp),
            });
          } else {
            const secret = parseTotpInput(newValue);
            if (!secret) {
              await sendTelegramMessage(env, '❌ 无效的2FA密钥，请输入 Base32 密钥或 otpauth:// URI');
            } else {
              entry.totp = secret;
              await setPasswordEntry(env, name, entry);
              await deleteMessage(env, msg.message_id);
              await deleteMessage(env, replyTo.message_id);
              const text = `✅ 已设置2FA\n\n` + buildPwdDetailText(name, entry, false);
              await sendTelegramMessage(env, text, null, {
                reply_markup: buildPwdDetailKeyboard(name, false, false, !!entry.password, !!entry.totp),
              });
            }
          }
        } else {
          if (field === '用户名') entry.username = newValue;
          else if (field === '密码') entry.password = newValue;
          else if (field === '备注') entry.note = newValue;
          await setPasswordEntry(env, name, entry);
          await deleteMessage(env, msg.message_id);
          await deleteMessage(env, replyTo.message_id);
          const text = `✅ 已更新${field}\n\n` + buildPwdDetailText(name, entry, false);
          await sendTelegramMessage(env, text, null, {
            reply_markup: buildPwdDetailKeyboard(name, false, false, !!entry.password, !!entry.totp),
          });
        }
      }
    }
  } catch (err) {
    console.error('Password reply error:', err);
    try { await sendTelegramMessage(env, `❌ 执行出错: ${err.message}`); } catch {}
  }
}
