import { encryptData, decryptData } from './crypto.js';

// ============ 存储管理常量 ============

export const MAX_STORAGE = 300 * 1024 * 1024; // 300MB
export const STAR_MAX_STORAGE = 50 * 1024 * 1024; // 50MB
export const EML_TTL = 5184000; // 60 days in seconds
export const RATE_WINDOW = 300000;  // 5 分钟滑动窗口（ms）
export const RATE_THRESHOLD = 10;   // 窗口内超过此数切换精简模式

export const IMAGE_TTL_TIERS = [
  { max: 1 * 1024 * 1024, ttl: 5184000 },   // <1MB → 60d
  { max: 2 * 1024 * 1024, ttl: 2592000 },   // 1-2MB → 30d
  { max: 5 * 1024 * 1024, ttl: 1296000 },   // 2-5MB → 15d
  { max: Infinity, ttl: 604800 },             // >5MB → 7d
];

export function getImageTtl(size) {
  for (const tier of IMAGE_TTL_TIERS) {
    if (size <= tier.max) return tier.ttl;
  }
  return 604800;
}

// ============ 通用 KV ============

export async function getKVList(env, key) {
  if (!env.MAIL_CONFIG) return [];
  try {
    const val = await env.MAIL_CONFIG.get(key);
    return val ? JSON.parse(val) : [];
  } catch { return []; }
}
export async function setKVList(env, key, list) { await env.MAIL_CONFIG.put(key, JSON.stringify(list)); }

// ============ 规则管理 ============

export async function getActiveRules(env) { return getKVList(env, 'allowed_prefixes'); }
export async function getPausedRules(env) { return getKVList(env, 'paused_prefixes'); }
export async function setActiveRules(env, list) { await setKVList(env, 'allowed_prefixes', list); }
export async function setPausedRules(env, list) { await setKVList(env, 'paused_prefixes', list); }

// 每个前缀的域名限制
export async function getPrefixDomains(env) {
  if (!env.MAIL_CONFIG) return {};
  try {
    const val = await env.MAIL_CONFIG.get('prefix_domains');
    return val ? JSON.parse(val) : {};
  } catch { return {}; }
}
export async function setPrefixDomains(env, obj) {
  await env.MAIL_CONFIG.put('prefix_domains', JSON.stringify(obj));
}

// 屏蔽发件人
export async function getBlockedSenders(env) { return getKVList(env, 'blocked_senders'); }
export async function setBlockedSenders(env, list) { await setKVList(env, 'blocked_senders', list); }

// 静音发件人
export async function getMutedSenders(env) { return getKVList(env, 'muted_senders'); }
export async function setMutedSenders(env, list) { await setKVList(env, 'muted_senders', list); }

// 前缀静音
export async function getMutedPrefixes(env) { return getKVList(env, 'muted_prefixes'); }
export async function setMutedPrefixes(env, list) { await setKVList(env, 'muted_prefixes', list); }

// 全局静音
export async function getGlobalMute(env) {
  if (!env.MAIL_CONFIG) return false;
  try { return (await env.MAIL_CONFIG.get('global_mute')) === 'true'; }
  catch { return false; }
}
export async function setGlobalMute(env, muted) {
  await env.MAIL_CONFIG.put('global_mute', String(muted));
}

export function isAllowedRecipient(to, activeRules, pausedRules, prefixDomains) {
  if (activeRules.length === 0 && pausedRules.length === 0) return true;
  const [prefix, domain] = to.toLowerCase().split('@');
  if (!activeRules.includes(prefix)) return false;
  const allowed = (prefixDomains || {})[prefix] || [];
  if (allowed.length === 0) return true;
  return allowed.includes(domain);
}

// ============ 密码管理 ============

export async function getPasswordList(env) { return getKVList(env, 'pwd_list'); }
export async function setPasswordList(env, list) { return setKVList(env, 'pwd_list', list); }

export async function getPasswordEntry(env, name) {
  if (!env.MAIL_CONFIG) return null;
  try {
    const val = await env.MAIL_CONFIG.get(`pwd:${name}`);
    if (!val) return null;
    const encrypted = JSON.parse(val);
    const plaintext = await decryptData(env, encrypted);
    return JSON.parse(plaintext);
  } catch { return null; }
}

export async function setPasswordEntry(env, name, entry, { overwrite = true } = {}) {
  if (!overwrite) {
    const existing = await env.MAIL_CONFIG.get(`pwd:${name}`);
    if (existing) throw new Error(`密码条目 "${name}" 已存在`);
  }
  const plaintext = JSON.stringify(entry);
  const encrypted = await encryptData(env, plaintext);
  await env.MAIL_CONFIG.put(`pwd:${name}`, JSON.stringify(encrypted));
}

export async function deletePasswordEntry(env, name) {
  await env.MAIL_CONFIG.delete(`pwd:${name}`);
}

export async function resolvePwdName(env, value) {
  if (!value) return value;
  const entry = await getPasswordEntry(env, value);
  if (entry) return value;
  const list = await getPasswordList(env);
  const match = list.find(e => e.name.startsWith(value));
  return match ? match.name : value;
}

// ============ 密码回收站 ============

export const PWD_TRASH_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

export async function getTrashList(env) { return getKVList(env, 'pwd_trash'); }
export async function setTrashList(env, list) { return setKVList(env, 'pwd_trash', list); }

export async function getTrashEntry(env, deletedAt) {
  if (!env.MAIL_CONFIG) return null;
  try {
    const val = await env.MAIL_CONFIG.get(`pwd:trash:${deletedAt}`);
    if (!val) return null;
    const encrypted = JSON.parse(val);
    const plaintext = await decryptData(env, encrypted);
    return JSON.parse(plaintext);
  } catch { return null; }
}

export async function setTrashEntry(env, deletedAt, entry) {
  const plaintext = JSON.stringify(entry);
  const encrypted = await encryptData(env, plaintext);
  await env.MAIL_CONFIG.put(`pwd:trash:${deletedAt}`, JSON.stringify(encrypted));
}

export async function deleteTrashEntry(env, deletedAt) {
  await env.MAIL_CONFIG.delete(`pwd:trash:${deletedAt}`);
}

export async function moveToTrash(env, name) {
  const entry = await getPasswordEntry(env, name);
  if (!entry) return null;
  const deletedAt = Date.now();
  await setTrashEntry(env, deletedAt, entry);
  const trashList = await getTrashList(env);
  trashList.push({ name, deletedAt });
  await setTrashList(env, trashList);
  const pwdList = await getPasswordList(env);
  const idx = pwdList.findIndex(e => e.name === name);
  if (idx !== -1) pwdList.splice(idx, 1);
  await setPasswordList(env, pwdList);
  await deletePasswordEntry(env, name);
  return deletedAt;
}

export async function cleanExpiredTrash(env) {
  const list = await getTrashList(env);
  const now = Date.now();
  const remaining = [];
  const expired = [];
  for (const item of list) {
    if (now - item.deletedAt > PWD_TRASH_TTL) expired.push(item);
    else remaining.push(item);
  }
  if (expired.length === 0) return 0;
  await Promise.all(expired.map(item => deleteTrashEntry(env, item.deletedAt)));
  await setTrashList(env, remaining);
  return expired.length;
}

export async function restoreFromTrash(env, deletedAt) {
  const trashList = await getTrashList(env);
  const trashItem = trashList.find(t => t.deletedAt === deletedAt);
  if (!trashItem) return { ok: false, error: '回收站条目不存在' };
  const entry = await getTrashEntry(env, deletedAt);
  if (!entry) return { ok: false, error: '条目数据已丢失' };
  let finalName = trashItem.name;
  if (await getPasswordEntry(env, finalName)) {
    finalName = trashItem.name + '_恢复';
    if (await getPasswordEntry(env, finalName)) {
      finalName = trashItem.name + '_' + deletedAt;
    }
  }
  const enc = new TextEncoder();
  if (enc.encode(finalName).length > 60) {
    let base = finalName;
    while (enc.encode(base).length > 60) base = base.slice(0, -1);
    finalName = base;
    if (await getPasswordEntry(env, finalName)) {
      return { ok: false, error: '名称冲突，请手动重命名后重试' };
    }
  }
  try {
    await setPasswordEntry(env, finalName, entry, { overwrite: false });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const pwdList = await getPasswordList(env);
  pwdList.unshift({ name: finalName, ts: Date.now() });
  await setPasswordList(env, pwdList);
  const idx = trashList.findIndex(t => t.deletedAt === deletedAt);
  if (idx !== -1) trashList.splice(idx, 1);
  await setTrashList(env, trashList);
  await deleteTrashEntry(env, deletedAt);
  return { ok: true, name: finalName, wasRenamed: finalName !== trashItem.name };
}

// ============ 邮件元数据 ============

export async function saveMsgMeta(env, msgId, meta) {
  await env.MAIL_CONFIG.put(`msg_meta:${msgId}`, JSON.stringify(meta), { expirationTtl: 604800 }); // 7天过期
}
export async function getMsgMeta(env, msgId) {
  if (!env.MAIL_CONFIG) return null;
  try {
    const val = await env.MAIL_CONFIG.get(`msg_meta:${msgId}`);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

// ============ 邮件存储 ============

// 精简 .eml 构建（去掉附件，保留原始编码用于乱码恢复）
export function buildStrippedEml(rawEmail) {
  const rawBytes = rawEmail instanceof ArrayBuffer ? new Uint8Array(rawEmail) : new Uint8Array(rawEmail.slice ? rawEmail.slice(0) : rawEmail);
  const raw = new TextDecoder('latin1').decode(rawBytes);

  const boundaryMatch = raw.match(/boundary="?([^\s";]+)"?/i);
  if (!boundaryMatch) return rawBytes; // 单部分邮件，直接返回

  const boundary = boundaryMatch[1];
  const sep = '--' + boundary;
  const parts = raw.split(sep);

  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) { result.push(part); continue; }

    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) { result.push(part); continue; }

    const partHeaders = part.substring(0, hEnd);
    const ct = partHeaders.match(/Content-Type:\s*([^\r\n;]+)/i);
    const contentType = ct ? ct[1].trim().toLowerCase() : '';

    if (contentType.startsWith('text/') || contentType.startsWith('multipart/')) {
      result.push(part);
    } else {
      result.push(partHeaders + '\r\n\r\n[attachment removed]\r\n');
    }
  }

  const stripped = result.join(sep);
  const bytes = new Uint8Array(stripped.length);
  for (let i = 0; i < stripped.length; i++) bytes[i] = stripped.charCodeAt(i) & 0xFF;
  return bytes;
}

export async function saveStrippedEml(env, msgId, rawEmail) {
  try {
    const stripped = buildStrippedEml(rawEmail);
    await env.MAIL_CONFIG.put(`email_text:${msgId}`, stripped.buffer);
    return stripped.byteLength;
  } catch (err) {
    console.log('Failed to store stripped eml:', err.message);
    return 0;
  }
}

export async function getStrippedEml(env, msgId) {
  if (!env.MAIL_CONFIG) return null;
  try {
    return await env.MAIL_CONFIG.get(`email_text:${msgId}`, { type: 'arrayBuffer' });
  } catch { return null; }
}

export async function saveImage(env, msgId, idx, imageData) {
  try {
    await env.MAIL_CONFIG.put(`img:${msgId}:${idx}`, imageData);
    return true;
  } catch (err) {
    console.log(`Failed to store image ${idx}:`, err.message);
    return false;
  }
}

export async function getImage(env, msgId, idx) {
  if (!env.MAIL_CONFIG) return null;
  try {
    return await env.MAIL_CONFIG.get(`img:${msgId}:${idx}`, { type: 'arrayBuffer' });
  } catch { return null; }
}

// ============ 邮件频率检测 ============

export async function checkEmailRate(env) {
  const now = Date.now();
  try {
    const val = await env.MAIL_CONFIG.get('email_rate');
    let timestamps = val ? JSON.parse(val) : [];
    timestamps = timestamps.filter(ts => now - ts < RATE_WINDOW);
    timestamps.push(now);
    await env.MAIL_CONFIG.put('email_rate', JSON.stringify(timestamps), { expirationTtl: 600 });
    return timestamps.length > RATE_THRESHOLD;
  } catch {
    return false;
  }
}

// ============ 邮件索引 ============

export async function getEmailIndex(env) {
  if (!env.MAIL_CONFIG) return { entries: [], totalSize: 0 };
  try {
    const val = await env.MAIL_CONFIG.get('email_index');
    return val ? JSON.parse(val) : { entries: [], totalSize: 0 };
  } catch { return { entries: [], totalSize: 0 }; }
}

export async function setEmailIndex(env, index) {
  await env.MAIL_CONFIG.put('email_index', JSON.stringify(index));
}

export function calcStorageUsage(index) {
  let total = 0;
  for (const e of index.entries) {
    total += e.textSize || 0;
    for (const img of (e.images || [])) total += img.size;
  }
  return total;
}

export function cleanExpiredEntries(index) {
  const now = Date.now();
  const removed = [];
  for (let i = index.entries.length - 1; i >= 0; i--) {
    const entry = index.entries[i];
    if (entry.starred) continue;

    const textExpired = now > entry.ts + EML_TTL * 1000;
    let allImagesExpired = (entry.images || []).length === 0;
    if (!allImagesExpired) {
      allImagesExpired = (entry.images || []).every(img => now > entry.ts + img.ttl * 1000);
    }

    if (textExpired && allImagesExpired) {
      index.totalSize -= (entry.textSize || 0);
      for (const img of (entry.images || [])) index.totalSize -= img.size;
      removed.push(index.entries.splice(i, 1)[0]);
    }
  }
  if (index.totalSize < 0) index.totalSize = 0;
  return removed;
}

export async function evictForSpace(env, index, needed) {
  const target = MAX_STORAGE - needed;
  const now = Date.now();
  let evicted = 0;

  while (index.totalSize > target) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < index.entries.length; i++) {
      const entry = index.entries[i];
      if (entry.starred) continue;

      const entrySize = (entry.textSize || 0) +
        (entry.images || []).reduce((s, img) => s + img.size, 0);
      const maxTtl = Math.max(
        EML_TTL,
        ...(entry.images || []).map(img => img.ttl),
        1
      ) * 1000;
      const age = now - entry.ts;
      const score = 0.4 * (entrySize / (5 * 1024 * 1024)) + 0.6 * (age / maxTtl);

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const entry = index.entries[bestIdx];
    const delPromises = [];
    if (entry.textSize > 0) delPromises.push(env.MAIL_CONFIG.delete(`email_text:${entry.id}`));
    for (const img of (entry.images || [])) {
      delPromises.push(env.MAIL_CONFIG.delete(`img:${entry.id}:${img.idx}`));
    }
    await Promise.all(delPromises);

    index.totalSize -= (entry.textSize || 0);
    for (const img of (entry.images || [])) index.totalSize -= img.size;
    index.entries.splice(bestIdx, 1);
    evicted++;
  }

  if (index.totalSize < 0) index.totalSize = 0;
  return evicted;
}

// ============ 邮件索引清理 ============

export const MAX_EMAIL_ENTRIES = 5000;

export async function runEmailCleanup(env) {
  const idx = await getEmailIndex(env);
  const expired = cleanExpiredEntries(idx);
  if (expired.length > 0) {
    const delPromises = [];
    for (const ex of expired) {
      if (ex.textSize > 0) delPromises.push(env.MAIL_CONFIG.delete(`email_text:${ex.id}`));
      for (const img of (ex.images || [])) delPromises.push(env.MAIL_CONFIG.delete(`img:${ex.id}:${img.idx}`));
    }
    await Promise.all(delPromises);
    await setEmailIndex(env, idx);
  }
  return idx;
}

export async function trimOldEntries(env, idx) {
  const nonStarred = idx.entries.filter(e => !e.starred);
  if (nonStarred.length <= MAX_EMAIL_ENTRIES) return 0;
  nonStarred.sort((a, b) => a.ts - b.ts);
  const excess = nonStarred.slice(0, nonStarred.length - MAX_EMAIL_ENTRIES);
  const excessIds = new Set(excess.map(e => e.id));
  const delPromises = [];
  for (const entry of excess) {
    if (entry.textSize > 0) delPromises.push(env.MAIL_CONFIG.delete(`email_text:${entry.id}`));
    for (const img of (entry.images || [])) delPromises.push(env.MAIL_CONFIG.delete(`img:${entry.id}:${img.idx}`));
  }
  await Promise.all(delPromises);
  for (let i = idx.entries.length - 1; i >= 0; i--) {
    if (excessIds.has(idx.entries[i].id)) idx.entries.splice(i, 1);
  }
  idx.totalSize = calcStorageUsage(idx);
  return excess.length;
}

// ============ 搜索 ============

export async function saveSearchQuery(env, keyword) {
  await env.MAIL_CONFIG.put('search_query', keyword, { expirationTtl: 3600 });
}

export async function getSearchQuery(env) {
  return await env.MAIL_CONFIG.get('search_query') || '';
}

// ============ 管理页搜索 ============

export async function saveMgmtSearch(env, keyword) {
  await env.MAIL_CONFIG.put('mgmt_search', keyword, { expirationTtl: 3600 });
}
export async function getMgmtSearch(env) {
  if (!env.MAIL_CONFIG) return '';
  try { return await env.MAIL_CONFIG.get('mgmt_search') || ''; }
  catch { return ''; }
}
