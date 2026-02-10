import PostalMime from 'postal-mime';
import { esc, escAddr, formatAddress, formatAddressList, formatDate, formatSize, htmlToText, generateRandomPrefix } from '../shared/utils.js';
import {
  fetchWithRetry, sendTelegramMessage, sendTelegramPrompt,
  sendTelegramPhoto, sendTelegramDocument, sendTelegramMediaGroup,
  editMessageText, deleteMessage, answerCallbackQuery,
} from '../shared/telegram.js';
import { tryFixBodyEncoding } from './encoding.js';
import {
  getActiveRules, setActiveRules, getPausedRules, setPausedRules,
  getPrefixDomains, setPrefixDomains,
  getBlockedSenders, setBlockedSenders, getMutedSenders, setMutedSenders,
  getMutedPrefixes, setMutedPrefixes, getGlobalMute, setGlobalMute,
  isAllowedRecipient,
  saveMsgMeta, getMsgMeta, getEmailIndex, setEmailIndex, calcStorageUsage,
  evictForSpace, saveStrippedEml, getStrippedEml,
  saveImage, getImage, checkEmailRate,
  saveSearchQuery, getSearchQuery,
  saveMgmtSearch, getMgmtSearch,
  runEmailCleanup, trimOldEntries,
  getMaxStorage, getStarMaxStorage, getImageTtl,
  getAttachMaxSize, getBodyMaxLength, getTrackingPixelSize,
} from '../shared/storage.js';

// ============ 常量 ============

export const TG_MESSAGE_LIMIT = 4096;
export const BODY_MAX_LENGTH = 1500;
export const ATTACHMENT_MAX_SIZE = 5 * 1024 * 1024; // 5MB
export const TRACKING_PIXEL_MAX_SIZE = 2048; // 2KB

export const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/bmp',
]);
export const GIF_TYPE = 'image/gif';

export const SEARCH_PAGE_SIZE = 5;
export const MGMT_PAGE_SIZE = 6;

// ============ 附件函数 ============

export function base64ToBlob(b64, mimeType) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function getAttachmentSize(att) {
  if (!att.content) return 0;
  if (typeof att.content === 'string') return Math.ceil(att.content.length * 3 / 4);
  return att.content.byteLength || 0;
}

function extFromMime(mimeType) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/bmp': '.bmp', 'application/pdf': '.pdf',
    'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html',
    'application/json': '.json', 'application/xml': '.xml',
    'application/zip': '.zip',
  };
  return map[mimeType] || '';
}

// ============ 附件分类 ============

export function classifyAttachment(att, maxSize, trackingSize) {
  trackingSize = trackingSize ?? TRACKING_PIXEL_MAX_SIZE;
  const size = getAttachmentSize(att);
  const mime = (att.mimeType || '').toLowerCase();
  const isImage = IMAGE_TYPES.has(mime);
  const isGif = mime === GIF_TYPE;
  const isInline = att.disposition === 'inline' || att.related;

  if (!att.content) return { action: 'skip', size, mime };
  if (isImage && isInline && size < trackingSize) {
    return { action: 'ignore', size, mime };
  }
  if (size > maxSize) return { action: 'listOnly', size, mime };
  if (isGif) return { action: 'sendDocument', size, mime };
  if (isImage) return { action: 'sendPhoto', size, mime };
  return { action: 'sendDocument', size, mime };
}

export function buildAttachmentSummary(attachments, maxSize, trackingSize) {
  if (!attachments || attachments.length === 0) return '';
  let photos = 0, docs = 0, oversized = 0;
  for (const att of attachments) {
    const cls = classifyAttachment(att, maxSize, trackingSize);
    if (cls.action === 'sendPhoto') photos++;
    else if (cls.action === 'sendDocument') docs++;
    else if (cls.action === 'listOnly') oversized++;
  }
  const parts = [];
  if (photos > 0) parts.push(`${photos} 张图片`);
  if (docs > 0) parts.push(`${docs} 个文档`);
  if (oversized > 0) parts.push(`${oversized} 个超大文件`);
  return parts.length > 0 ? `附件: ${parts.join(', ')}` : '';
}

// ============ 消息格式化 ============

export function buildNotificationText(parsed, rawFrom, rawTo, bodyText, attachmentSummary, bodyMaxLen) {
  let header = `📧 <b>新邮件</b>\n\n`;
  header += `<b>发件人：</b>${escAddr(formatAddress(parsed.from) || rawFrom)}\n`;
  header += `<b>收件人：</b>${escAddr(formatAddressList(parsed.to) || rawTo)}\n`;

  if (parsed.cc && parsed.cc.length > 0) {
    header += `<b>抄送：</b>${escAddr(formatAddressList(parsed.cc))}\n`;
  }
  if (parsed.bcc && parsed.bcc.length > 0) {
    header += `<b>密送：</b>${escAddr(formatAddressList(parsed.bcc))}\n`;
  }
  if (parsed.replyTo && parsed.replyTo.length > 0) {
    const replyToStr = formatAddressList(parsed.replyTo);
    const fromStr = formatAddress(parsed.from) || rawFrom;
    if (replyToStr !== fromStr) {
      header += `<b>回复至：</b>${escAddr(replyToStr)}\n`;
    }
  }
  if (parsed.date) {
    header += `<b>时间：</b>${esc(formatDate(parsed.date))}\n`;
  }

  header += `<b>主题：</b>${esc(parsed.subject || '(无主题)')}\n`;

  if (attachmentSummary) {
    header += `\n📎 ${esc(attachmentSummary)}\n`;
  }

  header += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 计算正文可用空间
  const truncSuffix = '\n...(已截断)';
  let body = bodyText || '(无正文)';

  // 先按可读性截断
  bodyMaxLen = bodyMaxLen || BODY_MAX_LENGTH;
  if (body.length > bodyMaxLen) {
    body = body.substring(0, bodyMaxLen) + truncSuffix;
  }

  // 再检查 Telegram 限制（基于 esc 后的长度）
  let escaped = esc(body);
  if (header.length + escaped.length > TG_MESSAGE_LIMIT) {
    const available = TG_MESSAGE_LIMIT - header.length - esc(truncSuffix).length - 20;
    // 逐步缩短原始文本直到 esc 后符合限制
    let len = Math.min(body.length, available);
    while (len > 100) {
      const candidate = body.substring(0, len) + truncSuffix;
      if (header.length + esc(candidate).length <= TG_MESSAGE_LIMIT) {
        escaped = esc(candidate);
        break;
      }
      len -= 50;
    }
    if (header.length + escaped.length > TG_MESSAGE_LIMIT) {
      escaped = esc(body.substring(0, 100) + truncSuffix);
    }
  }

  return header + escaped;
}

// 通用正文截断辅助：确保 header + escaped body 不超过 TG 限制
function truncateBodyForTg(headerLen, body, maxLen) {
  const truncSuffix = '\n...(已截断)';
  if (body.length > maxLen) body = body.substring(0, maxLen) + truncSuffix;
  let escaped = esc(body);
  if (headerLen + escaped.length > TG_MESSAGE_LIMIT) {
    let len = Math.min(body.length, TG_MESSAGE_LIMIT - headerLen - esc(truncSuffix).length - 20);
    while (len > 100) {
      const candidate = body.substring(0, len) + truncSuffix;
      if (headerLen + esc(candidate).length <= TG_MESSAGE_LIMIT) {
        escaped = esc(candidate);
        break;
      }
      len -= 50;
    }
    if (headerLen + escaped.length > TG_MESSAGE_LIMIT) {
      escaped = esc(body.substring(0, 100) + truncSuffix);
    }
  }
  return escaped;
}

export function buildCompactNotificationText(parsed, rawFrom, rawTo) {
  const sender = escAddr(formatAddress(parsed.from) || rawFrom);
  const subject = esc(parsed.subject || '(无主题)');
  const time = parsed.date ? esc(formatDate(parsed.date)) : '';
  let text = `📧 ${sender}\n<b>${subject}</b>`;
  if (time) text += ` - ${time}`;
  const to = esc(rawTo);
  text += `\n收件人：${to}`;
  return text;
}

// ============ 邮件列表/设置 UI ============

export function buildListText(active, paused, prefixDomains, globalMute, mutedPrefixes, storageInfo) {
  if (active.length === 0 && paused.length === 0) {
    let text = '📧 未设置过滤，所有邮件均会转发。\n点击下方按钮添加。';
    if (globalMute) text += '\n\n🔇 全局静音已开启';
    if (storageInfo) {
      text += `\n\n💾 ${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
      if (storageInfo.used / storageInfo.total > 0.8) text += ' ⚠️';
    }
    return text;
  }
  let text = '📧 邮箱过滤规则：\n';
  if (globalMute) text += '🔇 全局静音已开启\n';
  const muted = mutedPrefixes || [];
  for (const p of active) {
    const domains = (prefixDomains || {})[p] || [];
    const isMuted = muted.includes(p);
    const domainStr = domains.length > 0 ? ` (@${domains.join(', @')})` : '';
    const muteStr = isMuted ? ' 🔇' : '';
    text += `✅ ${p}${domainStr}${muteStr}\n`;
  }
  for (const p of paused) {
    const domains = (prefixDomains || {})[p] || [];
    const domainStr = domains.length > 0 ? ` (@${domains.join(', @')})` : '';
    text += `⏸️ ${p}${domainStr} (已暂停)\n`;
  }
  if (storageInfo) {
    text += `\n💾 ${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
    if (storageInfo.used / storageInfo.total > 0.8) text += ' ⚠️';
  }
  return text.trim();
}

export function buildListKeyboard(active, paused, globalMute, starredCount) {
  const rows = [];
  for (const p of active) {
    rows.push([
      { text: `✅ ${p}`, callback_data: `pause:${p}` },
      { text: '⚙️', callback_data: `settings:${p}` },
    ]);
  }
  for (const p of paused) {
    rows.push([
      { text: `⏸️ ${p}`, callback_data: `resume:${p}` },
      { text: '⚙️', callback_data: `settings:${p}` },
    ]);
  }
  const addRow = [
    { text: '➕ 添加前缀', callback_data: 'add' },
    { text: '🎲 随机前缀', callback_data: 'random' },
  ];
  rows.push(addRow);
  const mgmtRow = [{ text: '📧 邮箱管理', callback_data: 'em' }];
  if (starredCount > 0) {
    mgmtRow.push({ text: `⭐ 收藏 (${starredCount})`, callback_data: 'starlist' });
  }
  rows.push(mgmtRow);
  const ctrlRow = [];
  if (active.length > 0) {
    ctrlRow.push({ text: '⏸️ 暂停全部', callback_data: 'pause_all' });
  } else if (paused.length > 0) {
    ctrlRow.push({ text: '✅ 启用全部', callback_data: 'resume_all' });
  }
  ctrlRow.push(globalMute
    ? { text: '🔔 取消静音', callback_data: 'global_unmute' }
    : { text: '🔇 全局静音', callback_data: 'global_mute' });
  rows.push(ctrlRow);
  return { inline_keyboard: rows };
}

// 子菜单：单个前缀的设置页面
export function buildSettingsText(prefix, domains, confirmDel, isMuted, confirmRmDomain) {
  let text = `⚙️ 设置: <b>${esc(prefix)}</b>`;
  if (isMuted) text += ' 🔇';
  text += '\n\n';
  if (domains.length > 0) {
    text += '允许的域名：\n';
    for (const d of domains) text += `  • @${esc(d)}\n`;
  } else {
    text += '允许的域名：所有\n';
  }
  if (confirmDel) text += '\n⚠️ 确认要删除此前缀吗？';
  if (confirmRmDomain) text += `\n⚠️ 确认要删除域名 @${esc(confirmRmDomain)} 吗？`;
  return text.trim();
}

export function buildSettingsKeyboard(prefix, domains, confirmDel, isMuted, confirmRmDomain) {
  const rows = [];
  for (const d of domains) {
    if (confirmRmDomain === d) {
      rows.push([
        { text: `⚠️ 确认删除 @${d}`, callback_data: `confirm_rm_domain:${prefix}:${d}` },
        { text: '取消', callback_data: `settings:${prefix}` },
      ]);
    } else {
      rows.push([
        { text: `@${d}`, callback_data: `noop` },
        { text: '❌', callback_data: `rm_domain:${prefix}:${d}` },
      ]);
    }
  }
  rows.push([{ text: '➕ 添加域名', callback_data: `add_domain:${prefix}` }]);
  rows.push([isMuted
    ? { text: '🔔 取消静音', callback_data: `unmute_prefix:${prefix}` }
    : { text: '🔇 静音此前缀', callback_data: `mute_prefix:${prefix}` },
  ]);
  if (confirmDel) {
    rows.push([
      { text: '⚠️ 确认删除', callback_data: `confirm_del:${prefix}` },
      { text: '取消', callback_data: `settings:${prefix}` },
    ]);
  } else {
    rows.push([{ text: '🗑 删除前缀', callback_data: `del:${prefix}` }]);
  }
  rows.push([{ text: '◀️ 返回', callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

// 邮件通知底部按钮
export function buildEmailActionKeyboard(notifMsgId, senderMuted, senderBlocked, attCount, starred) {
  const rows = [];
  // 第一行：附件 / .eml / 收藏 / 删除
  const fileRow = [];
  if (attCount > 0) {
    fileRow.push({ text: `📎 附件 (${attCount})`, callback_data: `att:${notifMsgId}` });
  }
  fileRow.push({ text: '📄 .eml', callback_data: `eml:${notifMsgId}` });
  fileRow.push(starred
    ? { text: '⭐ 取消收藏', callback_data: `unstar:${notifMsgId}` }
    : { text: '收藏', callback_data: `star:${notifMsgId}` });
  if (attCount > 0) {
    fileRow.push({ text: '🗑 删除附件', callback_data: `del_email:${notifMsgId}` });
  }
  rows.push(fileRow);
  // 第二行：发件人操作
  const muteBtn = senderMuted
    ? { text: '🔔 取消静音', callback_data: `us:${notifMsgId}` }
    : { text: '🔇 静音发件人', callback_data: `ms:${notifMsgId}` };
  const blockBtn = senderBlocked
    ? { text: '✅ 取消屏蔽', callback_data: `ubs:${notifMsgId}` }
    : { text: '⛔ 屏蔽发件人', callback_data: `bs:${notifMsgId}` };
  rows.push([muteBtn, blockBtn]);
  return { inline_keyboard: rows };
}

// ============ 搜索 ============

export function searchEntries(entries, keyword) {
  const kw = keyword.toLowerCase();
  return entries.filter(e =>
    (e.sender || '').toLowerCase().includes(kw) ||
    (e.subject || '').toLowerCase().includes(kw)
  );
}

export function formatDateShort(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function buildSearchText(keyword, results, page) {
  const total = results.length;
  const totalPages = Math.ceil(total / SEARCH_PAGE_SIZE);
  const start = page * SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE);

  let text = `🔍 搜索 "<b>${esc(keyword)}</b>"（共 ${total} 条`;
  if (totalPages > 1) text += `，第 ${page + 1}/${totalPages} 页`;
  text += '）\n\n';

  if (total === 0) {
    text += '没有找到匹配的邮件。';
    return text;
  }

  for (let i = 0; i < pageResults.length; i++) {
    const e = pageResults[i];
    const num = start + i + 1;
    const sender = e.sender ? esc(e.sender) : '未知发件人';
    const subject = e.subject ? esc(e.subject) : '(无主题)';
    const date = formatDateShort(e.ts);
    const star = e.starred ? ' ⭐' : '';
    text += `<b>${num}.</b> 📧 ${sender}${star}\n     ${subject} - ${date}\n\n`;
  }

  return text.trim();
}

export function buildSearchKeyboard(results, page) {
  const rows = [];
  const totalPages = Math.ceil(results.length / SEARCH_PAGE_SIZE);
  const start = page * SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE);

  // 查看按钮行
  const viewRow = [];
  for (let i = 0; i < pageResults.length; i++) {
    viewRow.push({ text: `${start + i + 1}. 查看`, callback_data: `search_view:${pageResults[i].id}` });
  }
  if (viewRow.length > 0) rows.push(viewRow);

  // 翻页行
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0) navRow.push({ text: '◀️ 上一页', callback_data: `search_page:${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: '▶️ 下一页', callback_data: `search_page:${page + 1}` });
    rows.push(navRow);
  }

  rows.push([{ text: '◀️ 返回', callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

// ============ 邮箱管理 ============

export function buildMergedSenderList(blockedList, mutedList) {
  const map = new Map();
  for (const addr of blockedList) map.set(addr, { blocked: true, muted: false });
  for (const addr of mutedList) {
    const ex = map.get(addr);
    if (ex) ex.muted = true;
    else map.set(addr, { blocked: false, muted: true });
  }
  return [...map.entries()]
    .map(([addr, s]) => ({ addr, ...s }))
    .sort((a, b) => a.addr.localeCompare(b.addr));
}

export function buildMgmtText(senders, page, storageInfo, confirmState, searchKeyword) {
  let text = searchKeyword
    ? `🔍 搜索 "<b>${esc(searchKeyword)}</b>"`
    : '📧 <b>邮箱管理</b>';
  text += '\n\n';
  if (senders.length === 0) {
    text += searchKeyword ? '没有匹配的地址。' : '没有屏蔽或静音的发件人。';
  } else {
    const totalPages = Math.ceil(senders.length / MGMT_PAGE_SIZE);
    text += searchKeyword
      ? `匹配 ${senders.length} 个`
      : `屏蔽/静音列表（${senders.length} 个`;
    if (totalPages > 1) text += `，第 ${page + 1}/${totalPages} 页`;
    text += searchKeyword ? '：\n' : '）：\n';
    const start = page * MGMT_PAGE_SIZE;
    const pageItems = senders.slice(start, start + MGMT_PAGE_SIZE);
    for (const s of pageItems) {
      const icons = (s.blocked ? '⛔' : '') + (s.muted ? '🔇' : '');
      text += `${icons} ${escAddr(s.addr)}\n`;
    }
  }
  if (storageInfo) {
    text += `\n\n💾 ${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
    if (storageInfo.used / storageInfo.total > 0.8) text += ' ⚠️';
  }
  if (confirmState === 'att') text += '\n\n⚠️ 确认要清理所有非收藏邮件的附件吗？';
  else if (confirmState === 'all') text += '\n\n⚠️ 确认要清理所有非收藏邮件吗？';
  else if (confirmState === 'clrb') text += '\n\n⚠️ 确认要清空所有屏蔽发件人吗？';
  return text.trim();
}

export function buildMgmtKeyboard(senders, page, confirmState, searchKeyword) {
  const rows = [];
  const totalPages = Math.ceil(senders.length / MGMT_PAGE_SIZE) || 1;
  const start = page * MGMT_PAGE_SIZE;
  const pageItems = senders.slice(start, start + MGMT_PAGE_SIZE);
  const enc = new TextEncoder();
  for (const s of pageItems) {
    const icons = (s.blocked ? '⛔' : '') + (s.muted ? '🔇' : '');
    let cbAddr = s.addr;
    while (enc.encode('emr:' + cbAddr).length > 64) cbAddr = cbAddr.slice(0, -1);
    rows.push([{ text: `❌ ${s.addr} ${icons}`, callback_data: 'emr:' + cbAddr }]);
  }
  if (totalPages > 1) {
    const pp = searchKeyword ? 'emsp' : 'emp';
    const navRow = [];
    if (page > 0) navRow.push({ text: '◀️', callback_data: `${pp}:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) navRow.push({ text: '▶️', callback_data: `${pp}:${page + 1}` });
    rows.push(navRow);
  }
  if (!searchKeyword) {
    if (confirmState === 'att') {
      rows.push([
        { text: '⚠️ 确认清理附件', callback_data: 'emcca' },
        { text: '取消', callback_data: 'em' },
      ]);
    } else if (confirmState === 'all') {
      rows.push([
        { text: '⚠️ 确认清理邮件', callback_data: 'emccd' },
        { text: '取消', callback_data: 'em' },
      ]);
    } else if (confirmState === 'clrb') {
      rows.push([
        { text: '⚠️ 确认清空屏蔽', callback_data: 'emccb' },
        { text: '取消', callback_data: 'em' },
      ]);
    } else {
      rows.push([
        { text: '🧹 清理附件', callback_data: 'emca' },
        { text: '🗑 清理邮件', callback_data: 'emcd' },
      ]);
      const actionRow = [];
      if (senders.some(s => s.blocked)) {
        actionRow.push({ text: '🗑 清空屏蔽', callback_data: 'emcb' });
      }
      if (senders.length > 0) {
        actionRow.push({ text: '🔍 查询', callback_data: 'ems' });
      }
      if (actionRow.length > 0) rows.push(actionRow);
    }
    rows.push([{ text: '◀️ 返回', callback_data: 'back' }]);
  } else {
    rows.push([{ text: '◀️ 返回管理', callback_data: 'em' }]);
  }
  return { inline_keyboard: rows };
}

// ============ 收藏 ============

export function buildStarredListText(starredEntries, metaMap, starMaxStorage) {
  if (starredEntries.length === 0) return '⭐ 没有收藏的邮件。';
  const maxStar = starMaxStorage || 50 * 1024 * 1024;
  let text = '⭐ 收藏邮件：\n\n';
  let totalStarredSize = 0;
  for (let n = 0; n < starredEntries.length; n++) {
    const entry = starredEntries[n];
    const meta = metaMap[entry.id];
    const subject = meta?.subject || entry.subject || '(无主题)';
    const sender = meta?.sender || entry.sender || 'unknown';
    const date = new Date(entry.ts);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
    const imgCount = (entry.images || []).length;
    const entrySize = (entry.textSize || 0) + (entry.images || []).reduce((s, img) => s + img.size, 0);
    totalStarredSize += entrySize;
    text += `${n + 1}. ★ <b>${esc(subject)}</b>\n`;
    text += `   ${escAddr(sender)} · ${dateStr}`;
    if (imgCount > 0) text += ` · ${imgCount} 张图片`;
    text += ` · ${formatSize(entrySize)}\n\n`;
  }
  text += `\n💾 收藏占用: ${formatSize(totalStarredSize)} / ${formatSize(maxStar)}`;
  return text.trim();
}

export function buildStarredListKeyboard(starredEntries, confirmDelId) {
  const rows = [];
  for (let n = 0; n < starredEntries.length; n++) {
    const entry = starredEntries[n];
    if (confirmDelId === entry.id) {
      rows.push([
        { text: '⚠️ 确认删除邮件', callback_data: `confirm_del_att:${entry.id}` },
        { text: '取消', callback_data: 'starlist' },
      ]);
    } else {
      rows.push([
        { text: `${n + 1}. 📖 查看`, callback_data: `view_star:${entry.id}` },
        { text: '🗑 删除邮件', callback_data: `del_att:${entry.id}` },
      ]);
    }
  }
  rows.push([{ text: '◀️ 返回', callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

// ============ edit-to 函数 ============

export async function sendTelegramInlineList(env) {
  const [active, paused, pd, gm, mp, idx] = await Promise.all([
    getActiveRules(env), getPausedRules(env), getPrefixDomains(env),
    getGlobalMute(env), getMutedPrefixes(env), runEmailCleanup(env),
  ]);
  active.sort(); paused.sort();
  const storageInfo = { used: idx.totalSize, total: getMaxStorage(env) };
  const starredCount = idx.entries.filter(e => e.starred).length;
  const payload = {
    chat_id: env.TG_CHAT_ID,
    text: buildListText(active, paused, pd, gm, mp, storageInfo),
    reply_markup: buildListKeyboard(active, paused, gm, starredCount),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'sendInlineList',
  );
}

export async function editToList(env, msgId) {
  const [active, paused, pd, gm, mp, idx] = await Promise.all([
    getActiveRules(env), getPausedRules(env), getPrefixDomains(env),
    getGlobalMute(env), getMutedPrefixes(env), runEmailCleanup(env),
  ]);
  active.sort(); paused.sort();
  const storageInfo = { used: idx.totalSize, total: getMaxStorage(env) };
  const starredCount = idx.entries.filter(e => e.starred).length;
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text: buildListText(active, paused, pd, gm, mp, storageInfo),
    reply_markup: buildListKeyboard(active, paused, gm, starredCount),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editToList',
  );
}

export async function editToSettings(env, msgId, prefix, confirmDel, confirmRmDomain) {
  const [pd, mp] = await Promise.all([
    getPrefixDomains(env), getMutedPrefixes(env),
  ]);
  const domains = pd[prefix] || [];
  const isMuted = mp.includes(prefix);
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text: buildSettingsText(prefix, domains, confirmDel, isMuted, confirmRmDomain),
    parse_mode: 'HTML',
    reply_markup: buildSettingsKeyboard(prefix, domains, confirmDel, isMuted, confirmRmDomain),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editToSettings',
  );
}

export async function editToStarredList(env, msgId, confirmDelId) {
  const idx = await getEmailIndex(env);
  const starredEntries = idx.entries.filter(e => e.starred);
  // 批量获取 meta
  const metaMap = {};
  const metaResults = await Promise.all(
    starredEntries.map(e => getMsgMeta(env, e.id))
  );
  starredEntries.forEach((e, i) => { metaMap[e.id] = metaResults[i]; });
  let text = buildStarredListText(starredEntries, metaMap, getStarMaxStorage(env));
  if (confirmDelId) text += '\n\n⚠️ 确认要删除此邮件的所有存储数据吗？';
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text,
    parse_mode: 'HTML',
    reply_markup: buildStarredListKeyboard(starredEntries, confirmDelId),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editToStarredList',
  );
}

export async function editToSearchResults(env, msgId, keyword, page) {
  const idx = await getEmailIndex(env);
  const results = searchEntries(idx.entries, keyword);
  // 按时间倒序（最新的在前）
  results.sort((a, b) => b.ts - a.ts);
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text: buildSearchText(keyword, results, page),
    parse_mode: 'HTML',
    reply_markup: buildSearchKeyboard(results, page),
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editToSearchResults',
  );
}

export async function editToMgmt(env, msgId, page, confirmState, searchKeyword) {
  if (page === undefined) page = 0;
  const [blockedList, mutedList, idx] = await Promise.all([
    getBlockedSenders(env), getMutedSenders(env), runEmailCleanup(env),
  ]);
  let senders = buildMergedSenderList(blockedList, mutedList);
  if (searchKeyword) {
    const kw = searchKeyword.toLowerCase();
    senders = senders.filter(s => s.addr.toLowerCase().includes(kw));
  }
  const storageInfo = { used: idx.totalSize, total: getMaxStorage(env) };
  const text = buildMgmtText(senders, page, storageInfo, confirmState, searchKeyword);
  const keyboard = buildMgmtKeyboard(senders, page, confirmState, searchKeyword);
  return editMessageText(env, msgId, text, keyboard);
}

export async function updateEmailKeyboard(env, emailId, extraMsgId) {
  const [meta, mutedList, blockedList, idx] = await Promise.all([
    getMsgMeta(env, emailId), getMutedSenders(env), getBlockedSenders(env), getEmailIndex(env),
  ]);
  const entry = idx.entries.find(e => e.id === emailId);
  const starred = entry ? entry.starred : false;
  const senderAddr = (entry?.sender || meta?.sender || '').toLowerCase();
  const attCount = entry ? (entry.images || []).length : (meta?.attCount || 0);
  const keyboard = buildEmailActionKeyboard(emailId, mutedList.includes(senderAddr), blockedList.includes(senderAddr), attCount, starred);

  const updates = [];
  // 更新原始邮件通知
  if (meta || entry) {
    updates.push(fetchWithRetry(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: emailId, reply_markup: keyboard }) },
      'updateEmailKeyboard',
    ));
  }
  // 如果是从弹出消息操作，也更新弹出消息
  if (extraMsgId && extraMsgId !== emailId) {
    updates.push(fetchWithRetry(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: extraMsgId, reply_markup: keyboard }) },
      'updatePopupKeyboard',
    ));
  }
  await Promise.all(updates);
}

// ============ 命令处理 ============

export async function cmdAddPrefix(prefix, env) {
  if (!prefix || prefix.length > 64 || !/^[a-z0-9][a-z0-9._+-]*$/.test(prefix)) {
    await sendTelegramMessage(env, '❌ 前缀格式无效：仅允许小写字母、数字、. _ + -，最长64字符');
    return;
  }
  const active = await getActiveRules(env);
  const paused = await getPausedRules(env);
  const pausedIdx = paused.indexOf(prefix);
  if (pausedIdx !== -1) paused.splice(pausedIdx, 1);
  if (!active.includes(prefix)) active.push(prefix);
  await setActiveRules(env, active);
  await setPausedRules(env, paused);
  await sendTelegramInlineList(env);
}

export async function cmdAddDomain(prefix, domain, env) {
  const pd = await getPrefixDomains(env);
  if (!pd[prefix]) pd[prefix] = [];
  if (!pd[prefix].includes(domain)) pd[prefix].push(domain);
  await setPrefixDomains(env, pd);
  await sendTelegramMessage(env, `✅ 已为 <b>${esc(prefix)}</b> 添加域名 @${esc(domain)}`);
}

export async function cmdList(env) {
  await sendTelegramInlineList(env);
}

export async function cmdSearch(keyword, env) {
  if (!keyword) {
    await sendTelegramPrompt(env, '请输入搜索关键词（发件人/主题）：');
    return;
  }
  await saveSearchQuery(env, keyword);
  const idx = await getEmailIndex(env);
  const results = searchEntries(idx.entries, keyword);
  results.sort((a, b) => b.ts - a.ts);
  await sendTelegramMessage(env, buildSearchText(keyword, results, 0), null, {
    reply_markup: buildSearchKeyboard(results, 0),
  });
}

// ============ handleEmailCallback ============

export async function handleEmailCallback(cbq, env, ctx) {
  const data = cbq.data;
  const msgId = cbq.message.message_id;
  if (data === 'noop') { await answerCallbackQuery(env, cbq.id); return; }

  const [action, ...rest] = data.split(':');
  const value = rest.join(':');
  let toast = '';

  // ====== 主列表操作 ======
  if (action === 'pause') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    const idx = active.indexOf(value);
    if (idx !== -1) { active.splice(idx, 1); paused.push(value); }
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = `⏸️ 已暂停 ${value}`;
    await editToList(env, msgId);
  } else if (action === 'resume') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    const idx = paused.indexOf(value);
    if (idx !== -1) { paused.splice(idx, 1); active.push(value); }
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = `✅ 已恢复 ${value}`;
    await editToList(env, msgId);
  } else if (action === 'pause_all') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    paused.push(...active); active.length = 0;
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = '⏸️ 已暂停全部';
    await editToList(env, msgId);
  } else if (action === 'resume_all') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    active.push(...paused); paused.length = 0;
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = '✅ 已启用全部';
    await editToList(env, msgId);
  } else if (action === 'add') {
    await sendTelegramPrompt(env, '请输入要添加的邮箱前缀：');
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'random') {
    const prefix = generateRandomPrefix();
    const active = await getActiveRules(env);
    if (!active.includes(prefix)) {
      active.push(prefix);
      await setActiveRules(env, active);
    }
    toast = `🎲 已添加 ${prefix}`;
    await editToList(env, msgId);
    await sendTelegramMessage(env, `🎲 已添加随机前缀：<b>${esc(prefix)}</b>`);
  } else if (action === 'global_mute') {
    await setGlobalMute(env, true);
    toast = '🔇 已开启全局静音';
    await editToList(env, msgId);
  } else if (action === 'global_unmute') {
    await setGlobalMute(env, false);
    toast = '🔔 已关闭全局静音';
    await editToList(env, msgId);

  } else if (action === 'back') {
    await editToList(env, msgId);

  // ====== 子菜单：前缀设置 ======
  } else if (action === 'settings') {
    await editToSettings(env, msgId, value);
  } else if (action === 'del') {
    await editToSettings(env, msgId, value, true);
    toast = `确认要删除 ${value} 吗？`;
  } else if (action === 'confirm_del') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    const wasActive = active.includes(value);
    let idx = active.indexOf(value);
    if (idx !== -1) active.splice(idx, 1);
    idx = paused.indexOf(value);
    if (idx !== -1) paused.splice(idx, 1);
    await setActiveRules(env, active); await setPausedRules(env, paused);
    // 清理域名配置和静音状态
    const [pd, mp] = await Promise.all([getPrefixDomains(env), getMutedPrefixes(env)]);
    const deletedDomains = pd[value] || [];
    delete pd[value];
    const mpIdx = mp.indexOf(value);
    if (mpIdx !== -1) mp.splice(mpIdx, 1);
    await Promise.all([setPrefixDomains(env, pd), mpIdx !== -1 ? setMutedPrefixes(env, mp) : null]);
    toast = `❌ 已删除 ${value}`;
    await editToList(env, msgId);
    // 发送删除记录，方便误操作恢复
    let record = `🗑 已删除前缀 <b>${esc(value)}</b>`;
    record += wasActive ? '（原状态：启用）' : '（原状态：暂停）';
    if (deletedDomains.length > 0) {
      record += `\n域名限制：${deletedDomains.map(d => esc(d)).join(', ')}`;
    }
    await sendTelegramMessage(env, record);
  } else if (action === 'add_domain') {
    // value = prefix
    await sendTelegramPrompt(env, `请输入 ${value} 允许的域名：`);
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'rm_domain') {
    // value = "prefix:domain"
    const sepIdx = value.indexOf(':');
    const prefix = value.substring(0, sepIdx);
    const domain = value.substring(sepIdx + 1);
    toast = '⚠️ 再次点击确认删除';
    await editToSettings(env, msgId, prefix, false, domain);
  } else if (action === 'confirm_rm_domain') {
    const sepIdx = value.indexOf(':');
    const prefix = value.substring(0, sepIdx);
    const domain = value.substring(sepIdx + 1);
    const pd = await getPrefixDomains(env);
    const list = pd[prefix] || [];
    const idx = list.indexOf(domain);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) delete pd[prefix]; else pd[prefix] = list;
    await setPrefixDomains(env, pd);
    toast = `❌ 已移除 @${domain}`;
    await editToSettings(env, msgId, prefix);
  } else if (action === 'mute_prefix') {
    const mp = await getMutedPrefixes(env);
    if (!mp.includes(value)) mp.push(value);
    await setMutedPrefixes(env, mp);
    toast = `🔇 已静音 ${value}`;
    await editToSettings(env, msgId, value);
  } else if (action === 'unmute_prefix') {
    const mp = await getMutedPrefixes(env);
    const idx = mp.indexOf(value);
    if (idx !== -1) mp.splice(idx, 1);
    await setMutedPrefixes(env, mp);
    toast = `🔔 已取消静音 ${value}`;
    await editToSettings(env, msgId, value);

  // ====== 邮件通知：发件人操作 ======
  } else if (action === 'ms' || action === 'us' || action === 'bs' || action === 'ubs') {
    const targetId = parseInt(value);
    const [meta, idx] = await Promise.all([getMsgMeta(env, value), getEmailIndex(env)]);
    const entry = idx.entries.find(e => e.id === targetId);
    const sender = meta?.sender || entry?.sender || '';
    if (!sender) {
      toast = '⏰ 邮件数据已过期';
    } else if (action === 'ms') {
      const list = await getMutedSenders(env);
      if (!list.includes(sender)) list.push(sender);
      await setMutedSenders(env, list);
      toast = `🔇 已静音 ${sender}`;
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'us') {
      const list = await getMutedSenders(env);
      const i = list.indexOf(sender);
      if (i !== -1) list.splice(i, 1);
      await setMutedSenders(env, list);
      toast = `🔔 已取消静音 ${sender}`;
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'bs') {
      const list = await getBlockedSenders(env);
      if (!list.includes(sender)) list.push(sender);
      await setBlockedSenders(env, list);
      toast = `⛔ 已屏蔽 ${sender}`;
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'ubs') {
      const list = await getBlockedSenders(env);
      const i = list.indexOf(sender);
      if (i !== -1) list.splice(i, 1);
      await setBlockedSenders(env, list);
      toast = `✅ 已取消屏蔽 ${sender}`;
      await updateEmailKeyboard(env, targetId, msgId);
    }

  // ====== 邮件通知：按需下载 ======
  } else if (action === 'att') {
    const targetId = parseInt(value);
    const [meta, idx] = await Promise.all([
      getMsgMeta(env, value), getEmailIndex(env),
    ]);
    const entry = idx.entries.find(e => e.id === targetId);
    // 优先用 meta.images，meta 过期时 fallback 到 index entry
    const imageList = (meta?.images?.length > 0)
      ? meta.images
      : (entry?.images || []).map(img => ({
          i: img.idx, fn: img.fn || `image_${img.idx}`, mime: img.mime || 'application/octet-stream',
        }));
    if (imageList.length === 0) {
      toast = '没有可下载的图片附件';
    } else {
      const mediaItems = [];
      for (const img of imageList) {
        const data = await getImage(env, value, img.i);
        if (!data) continue;
        const blob = new Blob([data], { type: img.mime });
        const isPhoto = IMAGE_TYPES.has(img.mime);
        mediaItems.push({
          type: isPhoto ? 'photo' : 'document',
          blob,
          filename: img.fn,
        });
      }
      if (mediaItems.length === 0) {
        toast = '⏰ 附件已过期';
      } else {
        await sendTelegramMediaGroup(env, mediaItems, msgId);
        toast = `📎 已发送 ${mediaItems.length} 个附件`;
      }
    }
  } else if (action === 'eml') {
    const emlData = await getStrippedEml(env, value);
    if (!emlData) { toast = '⏰ 邮件数据已过期'; }
    else {
      const meta = await getMsgMeta(env, value);
      const subjectClean = (meta?.subject || 'email').replace(/[^\w\u4e00-\u9fff -]/g, '_').substring(0, 50);
      const emlBlob = new Blob([emlData], { type: 'message/rfc822' });
      await sendTelegramDocument(env, emlBlob, `${subjectClean}.eml`, msgId);
      toast = '📄 .eml 已发送';
    }

  // ====== 邮件通知：收藏 ======
  } else if (action === 'star') {
    const notifId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === notifId);
    if (!entry) { toast = '⏰ 邮件数据已过期'; }
    else {
      // 检查收藏容量
      let starredSize = 0;
      for (const e of idx.entries) {
        if (e.starred) {
          starredSize += (e.textSize || 0);
          for (const img of (e.images || [])) starredSize += img.size;
        }
      }
      const entrySize = (entry.textSize || 0) +
        (entry.images || []).reduce((s, img) => s + img.size, 0);
      const starMax = getStarMaxStorage(env);
      if (starredSize + entrySize > starMax) {
        toast = `⚠️ 收藏空间不足（${formatSize(starredSize)}/${formatSize(starMax)}）`;
      } else {
        entry.starred = true;
        await setEmailIndex(env, idx);
        toast = '⭐ 已收藏';
        await updateEmailKeyboard(env, notifId, msgId);
      }
    }
  } else if (action === 'unstar') {
    const notifId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === notifId);
    if (entry) {
      entry.starred = false;
      await setEmailIndex(env, idx);
      toast = '已取消收藏';
      await updateEmailKeyboard(env, notifId, msgId);
    }

  // ====== 列表：收藏列表 ======
  } else if (action === 'starlist') {
    await editToStarredList(env, msgId);

  // ====== 收藏列表：查看原邮件 ======
  } else if (action === 'view_star') {
    const targetId = parseInt(value);
    const [idx, emlData, mutedList, blockedList] = await Promise.all([
      getEmailIndex(env), getStrippedEml(env, targetId),
      getMutedSenders(env), getBlockedSenders(env),
    ]);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry && !emlData) { toast = '⏰ 邮件数据已过期'; }
    else {
      const sender = entry?.sender || '';
      const subject = entry?.subject || '';
      let text = `📖 <b>收藏邮件</b>\n\n`;
      text += `<b>发件人：</b>${escAddr(sender || 'unknown')}\n`;
      text += `<b>主题：</b>${esc(subject || '(无主题)')}\n`;
      if (emlData) {
        try {
          const parsed = await new PostalMime().parse(emlData);
          let body = parsed.text || '';
          if (!body && parsed.html) body = htmlToText(parsed.html);
          if (body) {
            const bml = getBodyMaxLength(env);
            const sep = '\n━━━━━━━━━━━━━━━━━━━━\n\n';
            text += sep + truncateBodyForTg(text.length + sep.length, body, bml);
          }
        } catch { /* 解析失败 */ }
      }
      const senderAddr = sender.toLowerCase();
      const senderMuted = mutedList.includes(senderAddr);
      const senderBlocked = blockedList.includes(senderAddr);
      const attCount = entry ? (entry.images || []).length : 0;
      const starred = entry ? entry.starred : false;
      const keyboard = buildEmailActionKeyboard(targetId, senderMuted, senderBlocked, attCount, starred);
      await sendTelegramMessage(env, text, null, { reply_markup: keyboard });
    }

  // ====== 收藏列表：删除单封邮件（确认） ======
  } else if (action === 'del_att') {
    const targetId = parseInt(value);
    toast = '⚠️ 再次点击确认删除';
    await editToStarredList(env, msgId, targetId);
  } else if (action === 'confirm_del_att') {
    const targetId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = '⏰ 邮件数据已过期'; }
    else {
      const delPromises = [];
      let freed = 0;
      for (const img of (entry.images || [])) {
        delPromises.push(env.KV.delete(`img:${targetId}:${img.idx}`));
        freed += img.size;
      }
      if (entry.textSize > 0) {
        delPromises.push(env.KV.delete(`email_text:${targetId}`));
        freed += entry.textSize;
      }
      await Promise.all(delPromises);
      entry.images = [];
      entry.textSize = 0;
      entry.starred = false;
      idx.totalSize = calcStorageUsage(idx);
      await setEmailIndex(env, idx);
      toast = `🗑 已删除，释放 ${formatSize(freed)}`;
      await editToStarredList(env, msgId);
    }

  // ====== 邮件通知：删除附件（确认） ======
  } else if (action === 'del_email') {
    const targetId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = '没有存储数据'; }
    else if (entry.starred) { toast = '⭐ 收藏邮件，请先取消收藏再删除'; }
    else {
      toast = '⚠️ 再次点击确认删除';
      const confirmKb = { inline_keyboard: [[
        { text: '⚠️ 确认删除附件', callback_data: `confirm_del_email:${targetId}` },
        { text: '取消', callback_data: `cancel_del_email:${targetId}` },
      ]] };
      await fetchWithRetry(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: targetId, reply_markup: confirmKb }) },
        'delEmailConfirm',
      );
    }
  } else if (action === 'confirm_del_email') {
    const targetId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry || (entry.images || []).length === 0) { toast = '没有可删除的附件'; }
    else {
      const delPromises = [];
      let freed = 0;
      for (const img of (entry.images || [])) {
        delPromises.push(env.KV.delete(`img:${targetId}:${img.idx}`));
        freed += img.size;
      }
      await Promise.all(delPromises);
      entry.images = [];
      idx.totalSize = calcStorageUsage(idx);
      await setEmailIndex(env, idx);
      const meta = await getMsgMeta(env, targetId);
      if (meta) {
        meta.attCount = 0;
        meta.images = [];
        await saveMsgMeta(env, targetId, meta);
      }
      toast = `🗑 已删除附件，释放 ${formatSize(freed)}`;
      await updateEmailKeyboard(env, targetId);
    }
  } else if (action === 'cancel_del_email') {
    await updateEmailKeyboard(env, parseInt(value));

  // ====== 邮箱管理页 ======
  } else if (action === 'em') {
    await editToMgmt(env, msgId);
  } else if (action === 'emr') {
    // 移除地址：双状态先删屏蔽，单状态直接删除
    const [blockedList, mutedList] = await Promise.all([
      getBlockedSenders(env), getMutedSenders(env),
    ]);
    const allAddrs = [...new Set([...blockedList, ...mutedList])];
    const fullAddr = allAddrs.includes(value) ? value : (allAddrs.find(a => a.startsWith(value)) || value);
    const isBlocked = blockedList.includes(fullAddr);
    const isMuted = mutedList.includes(fullAddr);
    if (isBlocked && isMuted) {
      blockedList.splice(blockedList.indexOf(fullAddr), 1);
      await setBlockedSenders(env, blockedList);
      toast = `✅ 已取消屏蔽 ${fullAddr}（仍在静音列表中）`;
    } else if (isBlocked) {
      blockedList.splice(blockedList.indexOf(fullAddr), 1);
      await setBlockedSenders(env, blockedList);
      toast = `✅ 已取消屏蔽 ${fullAddr}`;
    } else if (isMuted) {
      mutedList.splice(mutedList.indexOf(fullAddr), 1);
      await setMutedSenders(env, mutedList);
      toast = `✅ 已取消静音 ${fullAddr}`;
    }
    await editToMgmt(env, msgId);
  } else if (action === 'emp') {
    await editToMgmt(env, msgId, parseInt(value));
  } else if (action === 'emca') {
    toast = '⚠️ 再次点击确认清理';
    await editToMgmt(env, msgId, 0, 'att');
  } else if (action === 'emcca') {
    const idx = await getEmailIndex(env);
    let freed = 0;
    for (const entry of idx.entries) {
      if (entry.starred) continue;
      const delPromises = [];
      if (entry.textSize > 0) delPromises.push(env.KV.delete(`email_text:${entry.id}`));
      for (const img of (entry.images || [])) {
        delPromises.push(env.KV.delete(`img:${entry.id}:${img.idx}`));
        freed += img.size;
      }
      freed += entry.textSize || 0;
      await Promise.all(delPromises);
      entry.images = [];
      entry.textSize = 0;
    }
    idx.totalSize = calcStorageUsage(idx);
    await setEmailIndex(env, idx);
    toast = `🧹 已清理附件 ${formatSize(freed)}`;
    await editToMgmt(env, msgId);
  } else if (action === 'emcd') {
    toast = '⚠️ 再次点击确认清理';
    await editToMgmt(env, msgId, 0, 'all');
  } else if (action === 'emccd') {
    const idx = await getEmailIndex(env);
    let freed = 0;
    for (let i = idx.entries.length - 1; i >= 0; i--) {
      const entry = idx.entries[i];
      if (entry.starred) continue;
      const delPromises = [];
      if (entry.textSize > 0) delPromises.push(env.KV.delete(`email_text:${entry.id}`));
      for (const img of (entry.images || [])) {
        delPromises.push(env.KV.delete(`img:${entry.id}:${img.idx}`));
        freed += img.size;
      }
      freed += entry.textSize || 0;
      await Promise.all(delPromises);
      idx.entries.splice(i, 1);
    }
    idx.totalSize = calcStorageUsage(idx);
    await setEmailIndex(env, idx);
    toast = `🗑 已清理所有邮件 ${formatSize(freed)}`;
    await editToMgmt(env, msgId);
  } else if (action === 'emcb') {
    toast = '⚠️ 再次点击确认清空';
    await editToMgmt(env, msgId, 0, 'clrb');
  } else if (action === 'emccb') {
    await setBlockedSenders(env, []);
    toast = '✅ 已清空屏蔽列表';
    await editToMgmt(env, msgId);
  } else if (action === 'ems') {
    await sendTelegramPrompt(env, '请输入要查询的发件人地址关键词：');
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'emsp') {
    const keyword = await getMgmtSearch(env);
    if (!keyword) { toast = '搜索已过期，请重新查询'; }
    else { await editToMgmt(env, msgId, parseInt(value), null, keyword); }

  // ====== 搜索结果翻页/查看 ======
  } else if (action === 'search_page') {
    const page = parseInt(value);
    const keyword = await getSearchQuery(env);
    if (!keyword) { toast = '搜索已过期，请重新搜索'; }
    else { await editToSearchResults(env, msgId, keyword, page); }
  } else if (action === 'search_view') {
    const targetId = parseInt(value);
    const [idx, mutedList, blockedList] = await Promise.all([
      getEmailIndex(env), getMutedSenders(env), getBlockedSenders(env),
    ]);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = '邮件数据已过期'; }
    else {
      const emlData = entry.textSize > 0 ? await getStrippedEml(env, targetId) : null;
      let text = `📖 <b>邮件详情</b>\n\n`;
      text += `<b>发件人：</b>${escAddr(entry.sender || 'unknown')}\n`;
      text += `<b>主题：</b>${esc(entry.subject || '(无主题)')}\n`;
      if (emlData) {
        try {
          const parsed = await new PostalMime().parse(emlData);
          let body = parsed.text || '';
          if (!body && parsed.html) body = htmlToText(parsed.html);
          if (body) {
            const bml = getBodyMaxLength(env);
            const sep = '\n━━━━━━━━━━━━━━━━━━━━\n\n';
            text += sep + truncateBodyForTg(text.length + sep.length, body, bml);
          }
        } catch { /* 解析失败 */ }
      }
      const senderAddr = (entry.sender || '').toLowerCase();
      const senderMuted = mutedList.includes(senderAddr);
      const senderBlocked = blockedList.includes(senderAddr);
      const attCount = (entry.images || []).length;
      const keyboard = buildEmailActionKeyboard(targetId, senderMuted, senderBlocked, attCount, entry.starred);
      await sendTelegramMessage(env, text, null, { reply_markup: keyboard });
    }
  } else if (action === 'search_back') {
    const keyword = await getSearchQuery(env);
    if (!keyword) { toast = '搜索已过期，请重新搜索'; }
    else { await editToSearchResults(env, msgId, keyword, 0); }
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

// ============ handleEmailReply ============

export async function handleEmailReply(msg, replyTo, text, env) {
  const input = text.toLowerCase().trim();
  try {
    if (replyTo.text.startsWith('请输入要添加的邮箱前缀')) {
      await cmdAddPrefix(input, env);
    } else if (replyTo.text.includes('允许的域名')) {
      const match = replyTo.text.match(/请输入 (.+?) 允许的域名/);
      if (match) await cmdAddDomain(match[1], input, env);
    } else if (replyTo.text.startsWith('请输入搜索关键词')) {
      const keyword = text.trim();
      await saveSearchQuery(env, keyword);
      const idx = await getEmailIndex(env);
      const results = searchEntries(idx.entries, keyword);
      results.sort((a, b) => b.ts - a.ts);
      await sendTelegramMessage(env, buildSearchText(keyword, results, 0), null, {
        reply_markup: buildSearchKeyboard(results, 0),
      });
    } else if (replyTo.text.startsWith('请输入要查询的发件人地址关键词')) {
      const keyword = text.trim();
      await saveMgmtSearch(env, keyword);
      const [blockedList, mutedList, idx] = await Promise.all([
        getBlockedSenders(env), getMutedSenders(env), runEmailCleanup(env),
      ]);
      let senders = buildMergedSenderList(blockedList, mutedList);
      const kw = keyword.toLowerCase();
      senders = senders.filter(s => s.addr.toLowerCase().includes(kw));
      const storageInfo = { used: idx.totalSize, total: getMaxStorage(env) };
      await sendTelegramMessage(env,
        buildMgmtText(senders, 0, storageInfo, null, keyword), null, {
          reply_markup: buildMgmtKeyboard(senders, 0, null, keyword),
        });
    }
  } catch (err) {
    console.error('Webhook reply error:', err);
    try { await sendTelegramMessage(env, `❌ 执行出错: ${err.message}`); } catch {}
  }
}

// ============ handleIncomingEmail ============

export async function handleIncomingEmail(message, env) {
  try {
    const rawFrom = message.from || 'unknown';
    const rawTo = message.to || 'unknown';

    // 并行读取所有过滤和静音配置
    const senderAddr = rawFrom.toLowerCase();
    const [blockedSenders, activeRules, pausedRules, prefixDomains,
           globalMute, mutedPrefixes, mutedSenders] = await Promise.all([
      getBlockedSenders(env),
      getActiveRules(env), getPausedRules(env), getPrefixDomains(env),
      getGlobalMute(env), getMutedPrefixes(env), getMutedSenders(env),
    ]);

    if (blockedSenders.includes(senderAddr)) {
      console.log(`Blocked sender: ${rawFrom}`);
      return;
    }
    if (!isAllowedRecipient(rawTo, activeRules, pausedRules, prefixDomains)) {
      console.log(`Skipped: ${rawTo} (not allowed)`);
      return;
    }

    const prefix = rawTo.split('@')[0].toLowerCase();
    const shouldMute = globalMute || mutedPrefixes.includes(prefix) || mutedSenders.includes(senderAddr);

    // 邮件频率检测（含写入，需在过滤后执行）
    const isHighFreq = await checkEmailRate(env);

    let parsed;
    let rawEmail;
    try {
      rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime({ attachmentEncoding: 'base64' });
      parsed = await parser.parse(rawEmail);
    } catch (parseErr) {
      console.log('postal-mime parse failed:', parseErr.message);
      const subject = message.headers?.get('subject') || '(解析失败)';
      const fallbackText = `⚠️ <b>新邮件（解析失败）</b>\n\n`
        + `<b>发件人：</b>${esc(rawFrom)}\n`
        + `<b>收件人：</b>${esc(rawTo)}\n`
        + `<b>主题：</b>${esc(subject)}\n\n`
        + `━━━━━━━━━━━━━━━━━━━━\n\n`
        + `邮件解析失败，请登录邮箱查看原文。\n`
        + `错误信息：${esc(parseErr.message)}`;
      await sendTelegramMessage(env, fallbackText, null, { disable_notification: shouldMute });
      return;
    }

    // 编码修复 + 提取正文
    const fixed = tryFixBodyEncoding(new Uint8Array(rawEmail), parsed.text, parsed.html);
    let body = fixed.text || '';
    if (!body && fixed.html) {
      body = htmlToText(fixed.html);
    }
    if (!body) body = '(无正文)';

    // 附件分类：图片附件存储，非图片仅在通知中列出
    const maxSize = getAttachMaxSize(env);
    const trackingSize = getTrackingPixelSize(env);
    const bodyMaxLen = getBodyMaxLength(env);
    const attachmentSummary = buildAttachmentSummary(parsed.attachments, maxSize, trackingSize);

    // 列出非图片附件（仅通知，不存储）
    let nonImageInfo = '';
    const imageAtts = [];
    if (parsed.attachments) {
      const nonImages = [];
      for (const att of parsed.attachments) {
        const size = getAttachmentSize(att);
        const mime = (att.mimeType || '').toLowerCase();
        const isImage = IMAGE_TYPES.has(mime) || mime === GIF_TYPE;
        const isInline = att.disposition === 'inline' || att.related;
        if (!att.content) continue;
        if (isImage && isInline && size < trackingSize) continue; // 跟踪像素
        if (isImage) {
          imageAtts.push(att);
        } else {
          nonImages.push({ name: att.filename || 'unnamed', size });
        }
      }
      if (nonImages.length > 0) {
        nonImageInfo = '\n\n📋 非图片附件（不存储）：\n' +
          nonImages.map(f => `  - ${f.name} (${formatSize(f.size)})`).join('\n');
      }
    }

    // 退订链接提取
    let unsubInfo = '';
    const unsubHeader = parsed.headers?.find(h => h.key === 'list-unsubscribe');
    if (unsubHeader) {
      const urls = unsubHeader.value.match(/https?:\/\/[^\s>,]+/g);
      if (urls && urls.length > 0) {
        unsubInfo = `\n\n🔗 <a href="${esc(urls[0])}">退订此邮件列表</a>`;
      }
    }

    // 根据频率选择通知格式
    let text;
    if (isHighFreq) {
      text = buildCompactNotificationText(parsed, rawFrom, rawTo);
    } else {
      text = buildNotificationText(parsed, rawFrom, rawTo, body, attachmentSummary, bodyMaxLen);
      const extras = (nonImageInfo ? esc(nonImageInfo) : '') + unsubInfo;
      if (text.length + extras.length <= TG_MESSAGE_LIMIT) {
        text += extras;
      }
    }

    // 发送主通知（高频时强制静音）
    const senderIsMuted = mutedSenders.includes(senderAddr);
    const msgResult = await sendTelegramMessage(env, text, null, {
      disable_notification: shouldMute || isHighFreq,
    });
    const mainMessageId = msgResult?.result?.message_id;

    // 存储管理：精简 .eml + 图片附件
    if (mainMessageId) {
      // 1. 存储精简 .eml
      const emlSize = await saveStrippedEml(env, mainMessageId, rawEmail);

      // 2. 存储图片附件
      const storedImages = [];
      let totalImageSize = 0;

      const idx = await runEmailCleanup(env);
      const maxStorage = getMaxStorage(env);

      for (let i = 0; i < imageAtts.length; i++) {
        const att = imageAtts[i];
        const imgBytes = base64ToBlob(att.content, att.mimeType);
        const imgBuf = await imgBytes.arrayBuffer();
        const imgSize = imgBuf.byteLength;
        const ttl = getImageTtl(imgSize);

        // 检查空间，必要时驱逐
        const needed = emlSize + totalImageSize + imgSize;
        if (idx.totalSize + needed > maxStorage) {
          await evictForSpace(env, idx, needed);
        }
        // 仍然超出则跳过这张图片
        if (idx.totalSize + needed > maxStorage) {
          console.log(`Skipping image ${i}: storage full`);
          continue;
        }

        if (await saveImage(env, mainMessageId, i, imgBuf)) {
          storedImages.push({ i, fn: att.filename || `image_${i}${extFromMime(att.mimeType)}`, mime: att.mimeType, size: imgSize, ttl });
          totalImageSize += imgSize;
        }
      }

      // 3. 更新索引
      idx.entries.push({
        id: mainMessageId,
        ts: Date.now(),
        starred: false,
        textSize: emlSize,
        images: storedImages.map(img => ({ idx: img.i, size: img.size, ttl: img.ttl, fn: img.fn, mime: img.mime })),
        sender: senderAddr,
        subject: (parsed.subject || '').substring(0, 100),
      });
      idx.totalSize += emlSize + totalImageSize;
      await trimOldEntries(env, idx);
      await setEmailIndex(env, idx);

      // 4. 保存元数据
      await saveMsgMeta(env, mainMessageId, {
        sender: senderAddr,
        subject: parsed.subject || '',
        attCount: storedImages.length,
        images: storedImages.map(img => ({ i: img.i, fn: img.fn, mime: img.mime })),
      });

      // 5. 添加操作按钮
      const keyboard = buildEmailActionKeyboard(mainMessageId, senderIsMuted, false, storedImages.length, false);
      await fetchWithRetry(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: mainMessageId, reply_markup: keyboard }) },
        'addEmailKeyboard',
      );
    }

    console.log('Email processed successfully');
  } catch (err) {
    console.log('Worker error:', err.message, err.stack);
    try {
      const rawFrom = message.from || 'unknown';
      const rawTo = message.to || 'unknown';
      await sendTelegramMessage(env,
        `❌ <b>邮件处理失败</b>\n\n`
        + `<b>发件人：</b>${esc(rawFrom)}\n`
        + `<b>收件人：</b>${esc(rawTo)}\n\n`
        + `请登录邮箱查看原文。`
      );
    } catch { /* 彻底失败，静默 */ }
  }
}
