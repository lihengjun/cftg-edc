import PostalMime from 'postal-mime';
import { esc, escAddr, formatAddress, formatAddressList, formatDate, formatSize, htmlToText, generateRandomPrefix } from '../shared/utils.js';
import { t } from '../i18n.js';
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
  if (photos > 0) parts.push(t('email.att.photos', { n: photos }));
  if (docs > 0) parts.push(t('email.att.docs', { n: docs }));
  if (oversized > 0) parts.push(t('email.att.oversized', { n: oversized }));
  return parts.length > 0 ? t('email.att.prefix') + parts.join(', ') : '';
}

// ============ 消息格式化 ============

export function buildNotificationText(parsed, rawFrom, rawTo, bodyText, attachmentSummary, bodyMaxLen) {
  let header = t('email.new');
  header += `${t('email.from')}${escAddr(formatAddress(parsed.from) || rawFrom)}\n`;
  header += `${t('email.to')}${escAddr(formatAddressList(parsed.to) || rawTo)}\n`;

  if (parsed.cc && parsed.cc.length > 0) {
    header += `${t('email.cc')}${escAddr(formatAddressList(parsed.cc))}\n`;
  }
  if (parsed.bcc && parsed.bcc.length > 0) {
    header += `${t('email.bcc')}${escAddr(formatAddressList(parsed.bcc))}\n`;
  }
  if (parsed.replyTo && parsed.replyTo.length > 0) {
    const replyToStr = formatAddressList(parsed.replyTo);
    const fromStr = formatAddress(parsed.from) || rawFrom;
    if (replyToStr !== fromStr) {
      header += `${t('email.replyTo')}${escAddr(replyToStr)}\n`;
    }
  }
  if (parsed.date) {
    header += `${t('email.time')}${esc(formatDate(parsed.date))}\n`;
  }

  header += `${t('email.subject')}${esc(parsed.subject || t('email.noSubject'))}\n`;

  if (attachmentSummary) {
    header += `\n📎 ${esc(attachmentSummary)}\n`;
  }

  header += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 计算正文可用空间
  const truncSuffix = t('email.truncated');
  let body = bodyText || t('email.noBody');

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
  const truncSuffix = t('email.truncated');
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
  const subject = esc(parsed.subject || t('email.noSubject'));
  const time = parsed.date ? esc(formatDate(parsed.date)) : '';
  let text = `📧 ${sender}\n<b>${subject}</b>`;
  if (time) text += ` - ${time}`;
  const to = esc(rawTo);
  text += `\n${t('email.recipient')}${to}`;
  return text;
}

// ============ 邮件列表/设置 UI ============

export function buildListText(active, paused, prefixDomains, globalMute, mutedPrefixes, storageInfo) {
  if (active.length === 0 && paused.length === 0) {
    let text = t('email.list.empty');
    if (globalMute) text += '\n\n' + t('email.list.globalMute');
    if (storageInfo) {
      text += `\n\n💾 ${formatSize(storageInfo.used)} / ${formatSize(storageInfo.total)}`;
      if (storageInfo.used / storageInfo.total > 0.8) text += ' ⚠️';
    }
    return text;
  }
  let text = t('email.list.title');
  if (globalMute) text += t('email.list.globalMute') + '\n';
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
    text += `⏸️ ${p}${domainStr} ${t('email.list.paused')}\n`;
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
    { text: t('email.list.addPrefix'), callback_data: 'add' },
    { text: t('email.list.randomPrefix'), callback_data: 'random' },
  ];
  rows.push(addRow);
  const ctrlRow = [{ text: t('email.list.mgmt'), callback_data: 'em' }];
  if (active.length > 0) {
    ctrlRow.push({ text: t('email.list.pauseAll'), callback_data: 'pause_all' });
  } else if (paused.length > 0) {
    ctrlRow.push({ text: t('email.list.resumeAll'), callback_data: 'resume_all' });
  }
  ctrlRow.push(globalMute
    ? { text: t('email.list.unmute'), callback_data: 'global_unmute' }
    : { text: t('email.list.mute'), callback_data: 'global_mute' });
  rows.push(ctrlRow);
  if (starredCount > 0) {
    rows.push([{ text: t('email.list.starred', { n: starredCount }), callback_data: 'starlist' }]);
  }
  return { inline_keyboard: rows };
}

// 子菜单：单个前缀的设置页面
export function buildSettingsText(prefix, domains, confirmDel, isMuted, confirmRmDomain) {
  let text = t('email.settings.title') + `<b>${esc(prefix)}</b>`;
  if (isMuted) text += ' 🔇';
  text += '\n\n';
  if (domains.length > 0) {
    text += t('email.settings.domains');
    for (const d of domains) text += `  • @${esc(d)}\n`;
  } else {
    text += t('email.settings.domainsAll');
  }
  if (confirmDel) text += t('email.settings.confirmDel');
  if (confirmRmDomain) text += t('email.settings.confirmRmDomain', { d: esc(confirmRmDomain) });
  return text.trim();
}

export function buildSettingsKeyboard(prefix, domains, confirmDel, isMuted, confirmRmDomain) {
  const rows = [];
  for (const d of domains) {
    if (confirmRmDomain === d) {
      rows.push([
        { text: t('email.settings.confirmDelDomain', { d }), callback_data: `confirm_rm_domain:${prefix}:${d}` },
        { text: t('btn.cancel'), callback_data: `settings:${prefix}` },
      ]);
    } else {
      rows.push([
        { text: `@${d}`, callback_data: `noop` },
        { text: '❌', callback_data: `rm_domain:${prefix}:${d}` },
      ]);
    }
  }
  rows.push([{ text: t('email.settings.addDomain'), callback_data: `add_domain:${prefix}` }]);
  rows.push([isMuted
    ? { text: t('email.settings.unmutePrefix'), callback_data: `unmute_prefix:${prefix}` }
    : { text: t('email.settings.mutePrefix'), callback_data: `mute_prefix:${prefix}` },
  ]);
  if (confirmDel) {
    rows.push([
      { text: t('email.settings.confirmDelBtn'), callback_data: `confirm_del:${prefix}` },
      { text: t('btn.cancel'), callback_data: `settings:${prefix}` },
    ]);
  } else {
    rows.push([{ text: t('email.settings.delPrefix'), callback_data: `del:${prefix}` }]);
  }
  rows.push([{ text: t('btn.back'), callback_data: 'back' }]);
  return { inline_keyboard: rows };
}

// 邮件通知底部按钮
export function buildEmailActionKeyboard(notifMsgId, senderMuted, senderBlocked, attCount, starred) {
  const rows = [];
  // 第一行：附件 / .eml / 收藏 / 删除
  const fileRow = [];
  if (attCount > 0) {
    fileRow.push({ text: t('email.btn.att', { n: attCount }), callback_data: `att:${notifMsgId}` });
  }
  fileRow.push({ text: t('email.btn.eml'), callback_data: `eml:${notifMsgId}` });
  fileRow.push(starred
    ? { text: t('email.btn.unstar'), callback_data: `unstar:${notifMsgId}` }
    : { text: t('email.btn.star'), callback_data: `star:${notifMsgId}` });
  if (attCount > 0) {
    fileRow.push({ text: t('email.btn.delAtt'), callback_data: `del_email:${notifMsgId}` });
  }
  rows.push(fileRow);
  // 第二行：发件人操作
  const muteBtn = senderMuted
    ? { text: t('email.btn.unmuteSender'), callback_data: `us:${notifMsgId}` }
    : { text: t('email.btn.muteSender'), callback_data: `ms:${notifMsgId}` };
  const blockBtn = senderBlocked
    ? { text: t('email.btn.unblockSender'), callback_data: `ubs:${notifMsgId}` }
    : { text: t('email.btn.blockSender'), callback_data: `bs:${notifMsgId}` };
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
  return t('email.search.dateShort', { m: d.getMonth() + 1, d: d.getDate() });
}

export function buildSearchText(keyword, results, page) {
  const total = results.length;
  const totalPages = Math.ceil(total / SEARCH_PAGE_SIZE);
  const start = page * SEARCH_PAGE_SIZE;
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE);

  let text = t('email.search.title', { kw: esc(keyword), total });
  if (totalPages > 1) text += t('email.search.page', { page: page + 1, pages: totalPages });
  text += '）\n\n';

  if (total === 0) {
    text += t('email.search.noResult');
    return text;
  }

  for (let i = 0; i < pageResults.length; i++) {
    const e = pageResults[i];
    const num = start + i + 1;
    const sender = e.sender ? esc(e.sender) : t('email.search.unknownSender');
    const subject = e.subject ? esc(e.subject) : t('email.noSubject');
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
    viewRow.push({ text: t('email.search.view', { n: start + i + 1 }), callback_data: `search_view:${pageResults[i].id}` });
  }
  if (viewRow.length > 0) rows.push(viewRow);

  // 翻页行
  if (totalPages > 1) {
    const navRow = [];
    if (page > 0) navRow.push({ text: t('email.search.prev'), callback_data: `search_page:${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: t('email.search.next'), callback_data: `search_page:${page + 1}` });
    rows.push(navRow);
  }

  rows.push([{ text: t('btn.back'), callback_data: 'back' }]);
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
    ? t('email.mgmt.searchTitle', { kw: esc(searchKeyword) })
    : t('email.mgmt.title');
  text += '\n\n';
  if (senders.length === 0) {
    text += searchKeyword ? t('email.mgmt.noMatch') : t('email.mgmt.noSenders');
  } else {
    const totalPages = Math.ceil(senders.length / MGMT_PAGE_SIZE);
    text += searchKeyword
      ? t('email.mgmt.matchCount', { n: senders.length })
      : t('email.mgmt.listCount', { n: senders.length });
    if (totalPages > 1) text += t('email.mgmt.page', { page: page + 1, pages: totalPages });
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
  if (confirmState === 'att') text += t('email.mgmt.confirmCleanAtt');
  else if (confirmState === 'all') text += t('email.mgmt.confirmCleanAll');
  else if (confirmState === 'clrb') text += t('email.mgmt.confirmClearBlock');
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
        { text: t('email.mgmt.btnConfirmAtt'), callback_data: 'emcca' },
        { text: t('btn.cancel'), callback_data: 'em' },
      ]);
    } else if (confirmState === 'all') {
      rows.push([
        { text: t('email.mgmt.btnConfirmAll'), callback_data: 'emccd' },
        { text: t('btn.cancel'), callback_data: 'em' },
      ]);
    } else if (confirmState === 'clrb') {
      rows.push([
        { text: t('email.mgmt.btnConfirmBlock'), callback_data: 'emccb' },
        { text: t('btn.cancel'), callback_data: 'em' },
      ]);
    } else {
      rows.push([
        { text: t('email.mgmt.btnCleanAtt'), callback_data: 'emca' },
        { text: t('email.mgmt.btnCleanAll'), callback_data: 'emcd' },
      ]);
      const actionRow = [];
      if (senders.some(s => s.blocked)) {
        actionRow.push({ text: t('email.mgmt.btnClearBlock'), callback_data: 'emcb' });
      }
      if (senders.length > 0) {
        actionRow.push({ text: t('email.mgmt.btnSearch'), callback_data: 'ems' });
      }
      if (actionRow.length > 0) rows.push(actionRow);
    }
    rows.push([{ text: t('btn.back'), callback_data: 'back' }]);
  } else {
    rows.push([{ text: t('email.mgmt.btnBackMgmt'), callback_data: 'em' }]);
  }
  return { inline_keyboard: rows };
}

// ============ 收藏 ============

export function buildStarredListText(starredEntries, metaMap, starMaxStorage) {
  if (starredEntries.length === 0) return t('email.star.empty');
  const maxStar = starMaxStorage || 50 * 1024 * 1024;
  let text = t('email.star.title');
  let totalStarredSize = 0;
  for (let n = 0; n < starredEntries.length; n++) {
    const entry = starredEntries[n];
    const meta = metaMap[entry.id];
    const subject = meta?.subject || entry.subject || t('email.noSubject');
    const sender = meta?.sender || entry.sender || 'unknown';
    const date = new Date(entry.ts);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
    const imgCount = (entry.images || []).length;
    const entrySize = (entry.textSize || 0) + (entry.images || []).reduce((s, img) => s + img.size, 0);
    totalStarredSize += entrySize;
    text += `${n + 1}. ★ <b>${esc(subject)}</b>\n`;
    text += `   ${escAddr(sender)} · ${dateStr}`;
    if (imgCount > 0) text += ` · ${t('email.star.photos', { n: imgCount })}`;
    text += ` · ${formatSize(entrySize)}\n\n`;
  }
  text += t('email.star.storage', { used: formatSize(totalStarredSize), total: formatSize(maxStar) });
  return text.trim();
}

export function buildStarredListKeyboard(starredEntries, confirmDelId) {
  const rows = [];
  for (let n = 0; n < starredEntries.length; n++) {
    const entry = starredEntries[n];
    if (confirmDelId === entry.id) {
      rows.push([
        { text: t('email.star.btnConfirmDel'), callback_data: `confirm_del_att:${entry.id}` },
        { text: t('btn.cancel'), callback_data: 'starlist' },
      ]);
    } else {
      rows.push([
        { text: t('email.star.btnView', { n: n + 1 }), callback_data: `view_star:${entry.id}` },
        { text: t('email.star.btnDel'), callback_data: `del_att:${entry.id}` },
      ]);
    }
  }
  rows.push([{ text: t('btn.back'), callback_data: 'back' }]);
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
  if (confirmDelId) text += t('email.star.confirmDel');
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
    await sendTelegramMessage(env, t('email.invalidPrefix'));
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
  await sendTelegramMessage(env, t('email.domainAdded', { prefix: esc(prefix), domain: esc(domain) }));
}

export async function cmdList(env) {
  await sendTelegramInlineList(env);
}

export async function cmdSearch(keyword, env) {
  if (!keyword) {
    await sendTelegramPrompt(env, t('email.prompt.search'));
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
    toast = t('email.toast.paused', { v: value });
    await editToList(env, msgId);
  } else if (action === 'resume') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    const idx = paused.indexOf(value);
    if (idx !== -1) { paused.splice(idx, 1); active.push(value); }
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = t('email.toast.resumed', { v: value });
    await editToList(env, msgId);
  } else if (action === 'pause_all') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    paused.push(...active); active.length = 0;
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = t('email.toast.pausedAll');
    await editToList(env, msgId);
  } else if (action === 'resume_all') {
    const active = await getActiveRules(env);
    const paused = await getPausedRules(env);
    active.push(...paused); paused.length = 0;
    await setActiveRules(env, active); await setPausedRules(env, paused);
    toast = t('email.toast.resumedAll');
    await editToList(env, msgId);
  } else if (action === 'add') {
    await sendTelegramPrompt(env, t('email.prompt.addPrefix'));
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'random') {
    const prefix = generateRandomPrefix();
    const active = await getActiveRules(env);
    if (!active.includes(prefix)) {
      active.push(prefix);
      await setActiveRules(env, active);
    }
    toast = t('email.toast.randomAdded', { v: prefix });
    await editToList(env, msgId);
    await sendTelegramMessage(env, t('email.toast.randomAddedMsg', { v: esc(prefix) }));
  } else if (action === 'global_mute') {
    await setGlobalMute(env, true);
    toast = t('email.toast.muteOn');
    await editToList(env, msgId);
  } else if (action === 'global_unmute') {
    await setGlobalMute(env, false);
    toast = t('email.toast.muteOff');
    await editToList(env, msgId);

  } else if (action === 'back') {
    await editToList(env, msgId);

  // ====== 子菜单：前缀设置 ======
  } else if (action === 'settings') {
    await editToSettings(env, msgId, value);
  } else if (action === 'del') {
    await editToSettings(env, msgId, value, true);
    toast = t('email.toast.confirmDel', { v: value });
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
    toast = t('email.toast.deleted', { v: value });
    await editToList(env, msgId);
    // 发送删除记录，方便误操作恢复
    let record = t('email.toast.deletedRecord', { v: esc(value) });
    record += wasActive ? t('email.toast.wasActive') : t('email.toast.wasPaused');
    if (deletedDomains.length > 0) {
      record += t('email.toast.domainLimit') + deletedDomains.map(d => esc(d)).join(', ');
    }
    await sendTelegramMessage(env, record);
  } else if (action === 'add_domain') {
    // value = prefix
    await sendTelegramPrompt(env, t('email.prompt.addDomain', { v: value }));
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'rm_domain') {
    // value = "prefix:domain"
    const sepIdx = value.indexOf(':');
    const prefix = value.substring(0, sepIdx);
    const domain = value.substring(sepIdx + 1);
    toast = t('email.toast.confirmRmDomain');
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
    toast = t('email.toast.domainRemoved', { d: domain });
    await editToSettings(env, msgId, prefix);
  } else if (action === 'mute_prefix') {
    const mp = await getMutedPrefixes(env);
    if (!mp.includes(value)) mp.push(value);
    await setMutedPrefixes(env, mp);
    toast = t('email.toast.prefixMuted', { v: value });
    await editToSettings(env, msgId, value);
  } else if (action === 'unmute_prefix') {
    const mp = await getMutedPrefixes(env);
    const idx = mp.indexOf(value);
    if (idx !== -1) mp.splice(idx, 1);
    await setMutedPrefixes(env, mp);
    toast = t('email.toast.prefixUnmuted', { v: value });
    await editToSettings(env, msgId, value);

  // ====== 邮件通知：发件人操作 ======
  } else if (action === 'ms' || action === 'us' || action === 'bs' || action === 'ubs') {
    const targetId = parseInt(value);
    const [meta, idx] = await Promise.all([getMsgMeta(env, value), getEmailIndex(env)]);
    const entry = idx.entries.find(e => e.id === targetId);
    const sender = meta?.sender || entry?.sender || '';
    if (!sender) {
      toast = t('email.toast.expired');
    } else if (action === 'ms') {
      const list = await getMutedSenders(env);
      if (!list.includes(sender)) list.push(sender);
      await setMutedSenders(env, list);
      toast = t('email.toast.senderMuted', { v: sender });
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'us') {
      const list = await getMutedSenders(env);
      const i = list.indexOf(sender);
      if (i !== -1) list.splice(i, 1);
      await setMutedSenders(env, list);
      toast = t('email.toast.senderUnmuted', { v: sender });
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'bs') {
      const list = await getBlockedSenders(env);
      if (!list.includes(sender)) list.push(sender);
      await setBlockedSenders(env, list);
      toast = t('email.toast.senderBlocked', { v: sender });
      await updateEmailKeyboard(env, targetId, msgId);
    } else if (action === 'ubs') {
      const list = await getBlockedSenders(env);
      const i = list.indexOf(sender);
      if (i !== -1) list.splice(i, 1);
      await setBlockedSenders(env, list);
      toast = t('email.toast.senderUnblocked', { v: sender });
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
      toast = t('email.toast.noAttachments');
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
        toast = t('email.toast.attExpired');
      } else {
        await sendTelegramMediaGroup(env, mediaItems, msgId);
        toast = t('email.toast.attSent', { n: mediaItems.length });
      }
    }
  } else if (action === 'eml') {
    const emlData = await getStrippedEml(env, value);
    if (!emlData) { toast = t('email.toast.expired'); }
    else {
      const meta = await getMsgMeta(env, value);
      const subjectClean = (meta?.subject || 'email').replace(/[^\w\u4e00-\u9fff -]/g, '_').substring(0, 50);
      const emlBlob = new Blob([emlData], { type: 'message/rfc822' });
      await sendTelegramDocument(env, emlBlob, `${subjectClean}.eml`, msgId);
      toast = t('email.toast.emlSent');
    }

  // ====== 邮件通知：收藏 ======
  } else if (action === 'star') {
    const notifId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === notifId);
    if (!entry) { toast = t('email.toast.expired'); }
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
        toast = t('email.toast.starFull', { used: formatSize(starredSize), total: formatSize(starMax) });
      } else {
        entry.starred = true;
        await setEmailIndex(env, idx);
        toast = t('email.toast.starred');
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
      toast = t('email.toast.unstarred');
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
    if (!entry && !emlData) { toast = t('email.toast.expired'); }
    else {
      const sender = entry?.sender || '';
      const subject = entry?.subject || '';
      let text = t('email.star.viewTitle');
      text += `${t('email.from')}${escAddr(sender || 'unknown')}\n`;
      text += `${t('email.subject')}${esc(subject || t('email.noSubject'))}\n`;
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
    toast = t('email.toast.confirmDelStar');
    await editToStarredList(env, msgId, targetId);
  } else if (action === 'confirm_del_att') {
    const targetId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = t('email.toast.expired'); }
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
      toast = t('email.toast.freedSpace', { size: formatSize(freed) });
      await editToStarredList(env, msgId);
    }

  // ====== 邮件通知：删除附件（确认） ======
  } else if (action === 'del_email') {
    const targetId = parseInt(value);
    const idx = await getEmailIndex(env);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = t('email.toast.noStorage'); }
    else if (entry.starred) { toast = t('email.toast.starredProtected'); }
    else {
      toast = t('email.toast.confirmDelStar');
      const confirmKb = { inline_keyboard: [[
        { text: t('email.btn.confirmDelAtt'), callback_data: `confirm_del_email:${targetId}` },
        { text: t('btn.cancel'), callback_data: `cancel_del_email:${targetId}` },
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
    if (!entry || (entry.images || []).length === 0) { toast = t('email.toast.noDelAtt'); }
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
      toast = t('email.toast.freedAtt', { size: formatSize(freed) });
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
      toast = t('email.toast.unblockStillMuted', { v: fullAddr });
    } else if (isBlocked) {
      blockedList.splice(blockedList.indexOf(fullAddr), 1);
      await setBlockedSenders(env, blockedList);
      toast = t('email.toast.unblocked', { v: fullAddr });
    } else if (isMuted) {
      mutedList.splice(mutedList.indexOf(fullAddr), 1);
      await setMutedSenders(env, mutedList);
      toast = t('email.toast.unmutedAddr', { v: fullAddr });
    }
    await editToMgmt(env, msgId);
  } else if (action === 'emp') {
    await editToMgmt(env, msgId, parseInt(value));
  } else if (action === 'emca') {
    toast = t('email.toast.confirmClean');
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
    toast = t('email.toast.cleanedAtt', { size: formatSize(freed) });
    await editToMgmt(env, msgId);
  } else if (action === 'emcd') {
    toast = t('email.toast.confirmClean');
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
    toast = t('email.toast.cleanedAll', { size: formatSize(freed) });
    await editToMgmt(env, msgId);
  } else if (action === 'emcb') {
    toast = t('email.toast.confirmClearBlock');
    await editToMgmt(env, msgId, 0, 'clrb');
  } else if (action === 'emccb') {
    await setBlockedSenders(env, []);
    toast = t('email.toast.clearedBlock');
    await editToMgmt(env, msgId);
  } else if (action === 'ems') {
    await sendTelegramPrompt(env, t('email.prompt.mgmtSearch'));
    await answerCallbackQuery(env, cbq.id);
    return;
  } else if (action === 'emsp') {
    const keyword = await getMgmtSearch(env);
    if (!keyword) { toast = t('email.toast.mgmtSearchExpired'); }
    else { await editToMgmt(env, msgId, parseInt(value), null, keyword); }

  // ====== 搜索结果翻页/查看 ======
  } else if (action === 'search_page') {
    const page = parseInt(value);
    const keyword = await getSearchQuery(env);
    if (!keyword) { toast = t('email.toast.searchExpired'); }
    else { await editToSearchResults(env, msgId, keyword, page); }
  } else if (action === 'search_view') {
    const targetId = parseInt(value);
    const [idx, mutedList, blockedList] = await Promise.all([
      getEmailIndex(env), getMutedSenders(env), getBlockedSenders(env),
    ]);
    const entry = idx.entries.find(e => e.id === targetId);
    if (!entry) { toast = t('email.toast.expired'); }
    else {
      const emlData = entry.textSize > 0 ? await getStrippedEml(env, targetId) : null;
      let text = t('email.star.detailTitle');
      text += `${t('email.from')}${escAddr(entry.sender || 'unknown')}\n`;
      text += `${t('email.subject')}${esc(entry.subject || t('email.noSubject'))}\n`;
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
    if (!keyword) { toast = t('email.toast.searchExpired'); }
    else { await editToSearchResults(env, msgId, keyword, 0); }
  }

  await answerCallbackQuery(env, cbq.id, toast);
}

// ============ handleEmailReply ============

export async function handleEmailReply(msg, replyTo, text, env) {
  const input = text.toLowerCase().trim();
  try {
    if (replyTo.text === t('email.prompt.addPrefix')) {
      await cmdAddPrefix(input, env);
    } else if (replyTo.text === t('email.prompt.search')) {
      const keyword = text.trim();
      await saveSearchQuery(env, keyword);
      const idx = await getEmailIndex(env);
      const results = searchEntries(idx.entries, keyword);
      results.sort((a, b) => b.ts - a.ts);
      await sendTelegramMessage(env, buildSearchText(keyword, results, 0), null, {
        reply_markup: buildSearchKeyboard(results, 0),
      });
    } else if (replyTo.text === t('email.prompt.mgmtSearch')) {
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
    } else {
      // Try addDomain pattern: extract prefix from template
      const marker = '\x00';
      const tpl = t('email.prompt.addDomain', { v: marker });
      const mi = tpl.indexOf(marker);
      if (mi !== -1) {
        const before = tpl.slice(0, mi);
        const after = tpl.slice(mi + 1);
        if (replyTo.text.startsWith(before) && replyTo.text.endsWith(after)) {
          const prefix = replyTo.text.slice(before.length, replyTo.text.length - after.length);
          if (prefix) await cmdAddDomain(prefix, input, env);
        }
      }
    }
  } catch (err) {
    console.error('Webhook reply error:', err);
    try { await sendTelegramMessage(env, t('error.exec', { err: err.message })); } catch {}
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
      const subject = message.headers?.get('subject') || t('email.parseFailed');
      const fallbackText = t('email.parseFailedTitle')
        + `${t('email.from')}${esc(rawFrom)}\n`
        + `${t('email.to')}${esc(rawTo)}\n`
        + `${t('email.subject')}${esc(subject)}\n\n`
        + `━━━━━━━━━━━━━━━━━━━━\n\n`
        + `${t('email.parseFailedBody')}\n`
        + `${t('email.parseFailedError')}${esc(parseErr.message)}`;
      await sendTelegramMessage(env, fallbackText, null, { disable_notification: shouldMute });
      return;
    }

    // 编码修复 + 提取正文
    const fixed = tryFixBodyEncoding(new Uint8Array(rawEmail), parsed.text, parsed.html);
    let body = fixed.text || '';
    if (!body && fixed.html) {
      body = htmlToText(fixed.html);
    }
    if (!body) body = t('email.noBody');

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
        nonImageInfo = t('email.att.nonImage') +
          nonImages.map(f => `  - ${f.name} (${formatSize(f.size)})`).join('\n');
      }
    }

    // 退订链接提取
    let unsubInfo = '';
    const unsubHeader = parsed.headers?.find(h => h.key === 'list-unsubscribe');
    if (unsubHeader) {
      const urls = unsubHeader.value.match(/https?:\/\/[^\s>,]+/g);
      if (urls && urls.length > 0) {
        unsubInfo = `\n\n🔗 <a href="${esc(urls[0])}">${t('email.att.unsubscribe')}</a>`;
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
        t('email.processFailed')
        + `${t('email.from')}${esc(rawFrom)}\n`
        + `${t('email.to')}${esc(rawTo)}\n\n`
        + t('email.checkOriginal')
      );
    } catch { /* 彻底失败，静默 */ }
  }
}
