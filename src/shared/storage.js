import { encryptData, decryptData } from './crypto.js';
import { t, setLang } from '../i18n.js';

// ============ 存储管理常量（可通过环境变量覆盖） ============

// 默认值（向后兼容，直接导出供测试使用）
export const MAX_STORAGE = 300 * 1024 * 1024; // 300MB
export const STAR_MAX_STORAGE = 50 * 1024 * 1024; // 50MB
export const EML_TTL = 5184000; // 60 days in seconds
export const RATE_WINDOW = 300000;  // 5 分钟滑动窗口（ms）
export const RATE_THRESHOLD = 10;   // 窗口内超过此数切换精简模式
export const MAX_EMAIL_ENTRIES = 5000;

// ============ 配置项定义 ============

export const CONFIG_ITEMS = [
  { key: 'maxStorageMB',     label: 'cfg.item.maxStorageMB',     unit: 'cfg.unit.mb',      min: 10,  max: 1000,  defaultVal: 300,  envKey: 'MAX_STORAGE_MB' },
  { key: 'starMaxStorageMB', label: 'cfg.item.starMaxStorageMB', unit: 'cfg.unit.mb',      min: 5,   max: 1000,  defaultVal: 50,   envKey: 'STAR_MAX_STORAGE_MB' },
  { key: 'emlTtlDays',       label: 'cfg.item.emlTtlDays',       unit: 'cfg.unit.days',    min: 1,   max: 365,   defaultVal: 60,   envKey: 'EML_TTL_DAYS' },
  { key: 'maxEmailEntries',  label: 'cfg.item.maxEmailEntries',  unit: 'cfg.unit.count',   min: 100, max: 50000, defaultVal: 5000,  envKey: 'MAX_EMAIL_ENTRIES' },
  { key: 'rateThreshold',    label: 'cfg.item.rateThreshold',    unit: 'cfg.unit.emails',  min: 1,   max: 100,   defaultVal: 10,   envKey: 'RATE_THRESHOLD',     desc: 'cfg.desc.rateThreshold' },
  { key: 'rateWindowMin',    label: 'cfg.item.rateWindowMin',    unit: 'cfg.unit.minutes', min: 1,   max: 30,    defaultVal: 5,    envKey: 'RATE_WINDOW_MIN',    desc: 'cfg.desc.rateWindowMin' },
  { key: 'attachMaxSizeMB',  label: 'cfg.item.attachMaxSizeMB',  unit: 'cfg.unit.mb',      min: 1,   max: 20,    defaultVal: 5,    envKey: 'ATTACH_MAX_SIZE_MB', desc: 'cfg.desc.attachMaxSizeMB' },
  { key: 'bodyMaxLength',    label: 'cfg.item.bodyMaxLength',    unit: 'cfg.unit.chars',   min: 200, max: 3500,  defaultVal: 1500, envKey: 'BODY_MAX_LEN',       desc: 'cfg.desc.bodyMaxLength' },
  { key: 'trackingPixelKB',  label: 'cfg.item.trackingPixelKB',  unit: 'cfg.unit.kb',      min: 1,   max: 50,    defaultVal: 2,    envKey: 'TRACKING_PIXEL_KB',  desc: 'cfg.desc.trackingPixelKB' },
  { key: 'maxPasswords',     label: 'cfg.item.maxPasswords',     unit: 'cfg.unit.count',   min: 0,   max: 10000, defaultVal: 0,    envKey: 'MAX_PASSWORDS' },
];

// ============ 系统配置 KV 读写 ============

export async function getSystemConfig(env) {
  if (!env.KV) return {};
  try {
    const val = await env.KV.get('sys_config');
    return val ? JSON.parse(val) : {};
  } catch { return {}; }
}

export async function setSystemConfig(env, config) {
  await env.KV.put('sys_config', JSON.stringify(config));
}

// 从配置中读取某项的值：KV config > env > 默认值
function getConfigValue(env, sysConfig, key) {
  const item = CONFIG_ITEMS.find(c => c.key === key);
  if (!item) return 0;
  if (sysConfig && sysConfig[key] !== undefined) return sysConfig[key];
  const envVal = parseInt(env[item.envKey]);
  if (envVal > 0 || (key === 'maxPasswords' && envVal === 0)) return envVal || item.defaultVal;
  return item.defaultVal;
}

// 安全解析整数：负数和非数字回退到 fallback
function safeParseInt(val, fallback) {
  const v = parseInt(val);
  return v > 0 ? v : fallback;
}

// 从 env 读取可配置值，fallback 到默认值（同步版本，兼容现有调用）
export function getMaxStorage(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'maxStorageMB') * 1024 * 1024;
  return safeParseInt(env.MAX_STORAGE_MB, 300) * 1024 * 1024;
}
export function getStarMaxStorage(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'starMaxStorageMB') * 1024 * 1024;
  return safeParseInt(env.STAR_MAX_STORAGE_MB, 50) * 1024 * 1024;
}
export function getEmlTtl(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'emlTtlDays') * 86400;
  return safeParseInt(env.EML_TTL_DAYS, 60) * 86400;
}
export function getMaxEmailEntries(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'maxEmailEntries');
  return safeParseInt(env.MAX_EMAIL_ENTRIES, 5000);
}
export function getRateThreshold(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'rateThreshold');
  return safeParseInt(env.RATE_THRESHOLD, 10);
}
export function getRateWindow(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'rateWindowMin') * 60000;
  return safeParseInt(env.RATE_WINDOW_MIN, 5) * 60000;
}
export function getAttachMaxSize(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'attachMaxSizeMB') * 1024 * 1024;
  return safeParseInt(env.ATTACH_MAX_SIZE_MB, 5) * 1024 * 1024;
}
export function getBodyMaxLength(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'bodyMaxLength');
  return safeParseInt(env.BODY_MAX_LEN, 1500);
}
export function getTrackingPixelSize(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'trackingPixelKB') * 1024;
  return safeParseInt(env.TRACKING_PIXEL_KB, 2) * 1024;
}
export function getMaxPasswords(env) {
  if (env._sysConfig) return getConfigValue(env, env._sysConfig, 'maxPasswords');
  return safeParseInt(env.MAX_PASSWORDS, 0); // 0 = 不限
}

// 异步加载 sysConfig 并挂载到 env（在请求入口调用一次）
export async function loadSystemConfig(env) {
  env._sysConfig = await getSystemConfig(env);
  setLang((env._sysConfig && env._sysConfig.lang) || 'en');
}

// 获取某项当前生效值（用于 UI 显示）
export function getEffectiveValue(env, key) {
  return getConfigValue(env, env._sysConfig, key);
}

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
  if (!env.KV) return [];
  try {
    const val = await env.KV.get(key);
    return val ? JSON.parse(val) : [];
  } catch { return []; }
}
export async function setKVList(env, key, list) { await env.KV.put(key, JSON.stringify(list)); }

// ============ 规则管理 ============

export async function getActiveRules(env) { return getKVList(env, 'allowed_prefixes'); }
export async function getPausedRules(env) { return getKVList(env, 'paused_prefixes'); }
export async function setActiveRules(env, list) { await setKVList(env, 'allowed_prefixes', list); }
export async function setPausedRules(env, list) { await setKVList(env, 'paused_prefixes', list); }

// 每个前缀的域名限制
export async function getPrefixDomains(env) {
  if (!env.KV) return {};
  try {
    const val = await env.KV.get('prefix_domains');
    return val ? JSON.parse(val) : {};
  } catch { return {}; }
}
export async function setPrefixDomains(env, obj) {
  await env.KV.put('prefix_domains', JSON.stringify(obj));
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
  if (!env.KV) return false;
  try { return (await env.KV.get('global_mute')) === 'true'; }
  catch { return false; }
}
export async function setGlobalMute(env, muted) {
  await env.KV.put('global_mute', String(muted));
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
  if (!env.KV) return null;
  try {
    const val = await env.KV.get(`pwd:${name}`);
    if (!val) return null;
    const encrypted = JSON.parse(val);
    const plaintext = await decryptData(env, encrypted);
    return JSON.parse(plaintext);
  } catch { return null; }
}

export async function setPasswordEntry(env, name, entry, { overwrite = true } = {}) {
  if (!overwrite) {
    const existing = await env.KV.get(`pwd:${name}`);
    if (existing) throw new Error(t('storage.pwdExists', { name }));
  }
  const plaintext = JSON.stringify(entry);
  const encrypted = await encryptData(env, plaintext);
  await env.KV.put(`pwd:${name}`, JSON.stringify(encrypted));
}

export async function deletePasswordEntry(env, name) {
  await env.KV.delete(`pwd:${name}`);
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
  if (!env.KV) return null;
  try {
    const val = await env.KV.get(`pwd:trash:${deletedAt}`);
    if (!val) return null;
    const encrypted = JSON.parse(val);
    const plaintext = await decryptData(env, encrypted);
    return JSON.parse(plaintext);
  } catch { return null; }
}

export async function setTrashEntry(env, deletedAt, entry) {
  const plaintext = JSON.stringify(entry);
  const encrypted = await encryptData(env, plaintext);
  await env.KV.put(`pwd:trash:${deletedAt}`, JSON.stringify(encrypted));
}

export async function deleteTrashEntry(env, deletedAt) {
  await env.KV.delete(`pwd:trash:${deletedAt}`);
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
  if (!trashItem) return { ok: false, error: t('storage.trashNotExist') };
  const entry = await getTrashEntry(env, deletedAt);
  if (!entry) return { ok: false, error: t('storage.trashDataLost') };
  let finalName = trashItem.name;
  if (await getPasswordEntry(env, finalName)) {
    finalName = trashItem.name + t('storage.restoreSuffix');
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
      return { ok: false, error: t('storage.nameConflict') };
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
  await env.KV.put(`msg_meta:${msgId}`, JSON.stringify(meta), { expirationTtl: 604800 }); // 7天过期
}
export async function getMsgMeta(env, msgId) {
  if (!env.KV) return null;
  try {
    const val = await env.KV.get(`msg_meta:${msgId}`);
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
    await env.KV.put(`email_text:${msgId}`, stripped.buffer);
    return stripped.byteLength;
  } catch (err) {
    console.log('Failed to store stripped eml:', err.message);
    return 0;
  }
}

export async function getStrippedEml(env, msgId) {
  if (!env.KV) return null;
  try {
    return await env.KV.get(`email_text:${msgId}`, { type: 'arrayBuffer' });
  } catch { return null; }
}

export async function saveImage(env, msgId, idx, imageData) {
  try {
    await env.KV.put(`img:${msgId}:${idx}`, imageData);
    return true;
  } catch (err) {
    console.log(`Failed to store image ${idx}:`, err.message);
    return false;
  }
}

export async function getImage(env, msgId, idx) {
  if (!env.KV) return null;
  try {
    return await env.KV.get(`img:${msgId}:${idx}`, { type: 'arrayBuffer' });
  } catch { return null; }
}

// ============ 邮件频率检测 ============

export async function checkEmailRate(env) {
  const now = Date.now();
  const threshold = getRateThreshold(env);
  const window = getRateWindow(env);
  try {
    const val = await env.KV.get('email_rate');
    let timestamps = val ? JSON.parse(val) : [];
    timestamps = timestamps.filter(ts => now - ts < window);
    timestamps.push(now);
    const ttl = Math.max(Math.ceil(window / 500), 60);
    await env.KV.put('email_rate', JSON.stringify(timestamps), { expirationTtl: ttl });
    return timestamps.length > threshold;
  } catch {
    return false;
  }
}

// ============ 邮件索引 ============

export async function getEmailIndex(env) {
  if (!env.KV) return { entries: [], totalSize: 0 };
  try {
    const val = await env.KV.get('email_index');
    return val ? JSON.parse(val) : { entries: [], totalSize: 0 };
  } catch { return { entries: [], totalSize: 0 }; }
}

export async function setEmailIndex(env, index) {
  await env.KV.put('email_index', JSON.stringify(index));
}

export function calcStorageUsage(index) {
  let total = 0;
  for (const e of index.entries) {
    total += e.textSize || 0;
    for (const img of (e.images || [])) total += img.size;
  }
  return total;
}

export function cleanExpiredEntries(index, env) {
  const now = Date.now();
  const emlTtl = env ? getEmlTtl(env) : EML_TTL;
  const removed = [];
  for (let i = index.entries.length - 1; i >= 0; i--) {
    const entry = index.entries[i];
    if (entry.starred) continue;

    const textExpired = now > entry.ts + emlTtl * 1000;
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
  const maxStorage = getMaxStorage(env);
  const emlTtl = getEmlTtl(env);
  const target = maxStorage - needed;
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
        emlTtl,
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
    if (entry.textSize > 0) delPromises.push(env.KV.delete(`email_text:${entry.id}`));
    for (const img of (entry.images || [])) {
      delPromises.push(env.KV.delete(`img:${entry.id}:${img.idx}`));
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

export async function runEmailCleanup(env) {
  const idx = await getEmailIndex(env);
  const expired = cleanExpiredEntries(idx, env);
  if (expired.length > 0) {
    const delPromises = [];
    for (const ex of expired) {
      if (ex.textSize > 0) delPromises.push(env.KV.delete(`email_text:${ex.id}`));
      for (const img of (ex.images || [])) delPromises.push(env.KV.delete(`img:${ex.id}:${img.idx}`));
    }
    await Promise.all(delPromises);
    await setEmailIndex(env, idx);
  }
  return idx;
}

export async function trimOldEntries(env, idx) {
  const maxEntries = getMaxEmailEntries(env);
  const nonStarred = idx.entries.filter(e => !e.starred);
  if (nonStarred.length <= maxEntries) return 0;
  nonStarred.sort((a, b) => a.ts - b.ts);
  const excess = nonStarred.slice(0, nonStarred.length - maxEntries);
  const excessIds = new Set(excess.map(e => e.id));
  const delPromises = [];
  for (const entry of excess) {
    if (entry.textSize > 0) delPromises.push(env.KV.delete(`email_text:${entry.id}`));
    for (const img of (entry.images || [])) delPromises.push(env.KV.delete(`img:${entry.id}:${img.idx}`));
  }
  await Promise.all(delPromises);
  for (let i = idx.entries.length - 1; i >= 0; i--) {
    if (excessIds.has(idx.entries[i].id)) idx.entries.splice(i, 1);
  }
  idx.totalSize = calcStorageUsage(idx);
  return excess.length;
}

// ============ 密码备份 ============

export const BACKUP_TTL = 2678400; // 31 days in seconds

export async function getBackupIndex(env) {
  return getKVList(env, 'pwd_backup_index');
}

export async function setBackupIndex(env, index) {
  return setKVList(env, 'pwd_backup_index', index);
}

export async function runPasswordBackup(env) {
  const list = await getPasswordList(env);
  if (list.length === 0) return { ok: true, count: 0 };

  const entries = {};
  for (const item of list) {
    const raw = await env.KV.get(`pwd:${item.name}`);
    if (raw) entries[item.name] = raw;
  }

  const date = new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify({ pwd_list: list, entries });
  await env.KV.put(`pwd_backup:${date}`, payload, { expirationTtl: BACKUP_TTL });

  const index = await getBackupIndex(env);
  const existing = index.findIndex(i => i.date === date);
  if (existing !== -1) {
    index[existing].count = list.length;
  } else {
    index.push({ date, count: list.length });
  }
  // 清理 >31 天的旧索引
  const cutoff = Date.now() - BACKUP_TTL * 1000;
  const cleaned = index.filter(i => new Date(i.date).getTime() > cutoff);
  cleaned.sort((a, b) => b.date.localeCompare(a.date));
  await setBackupIndex(env, cleaned);

  return { ok: true, count: list.length, date };
}

export async function restorePasswordBackup(env, date) {
  const raw = await env.KV.get(`pwd_backup:${date}`);
  if (!raw) return { ok: false, error: t('storage.backupNotExist') };

  const backup = JSON.parse(raw);
  await replaceAllPasswords(env, null, backup);
  return { ok: true, count: backup.pwd_list.length };
}

export async function replaceAllPasswords(env, entries, rawBackup) {
  // 删除旧数据
  const oldList = await getPasswordList(env);
  await Promise.all(oldList.map(item => deletePasswordEntry(env, item.name)));

  if (rawBackup) {
    // 从备份恢复（已加密的原始数据）
    for (const [name, encrypted] of Object.entries(rawBackup.entries)) {
      await env.KV.put(`pwd:${name}`, encrypted);
    }
    await setPasswordList(env, rawBackup.pwd_list);
  } else {
    // 从导入数据写入（明文 entries）
    const newList = [];
    for (const entry of entries) {
      const name = entry.name;
      const data = { username: entry.username || '', password: entry.password || '', note: entry.note || '', totp: entry.totp || '' };
      await setPasswordEntry(env, name, data);
      newList.push({ name, ts: Date.now() });
    }
    await setPasswordList(env, newList);
  }
}

// ============ 搜索 ============

export async function saveSearchQuery(env, keyword) {
  await env.KV.put('search_query', keyword, { expirationTtl: 3600 });
}

export async function getSearchQuery(env) {
  return await env.KV.get('search_query') || '';
}

// ============ 管理页搜索 ============

export async function saveMgmtSearch(env, keyword) {
  await env.KV.put('mgmt_search', keyword, { expirationTtl: 3600 });
}
export async function getMgmtSearch(env) {
  if (!env.KV) return '';
  try { return await env.KV.get('mgmt_search') || ''; }
  catch { return ''; }
}
