// ============ 工具函数 ============

export function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAddr(str) {
  // 用 <code> 包裹邮件地址防止 Telegram 自动链接吞掉前面的标签
  return esc(str).replace(/([^\s,<>&]+@[^\s,<>&]+)/g, '<code>$1</code>');
}

export function formatAddress(addr) {
  if (!addr) return '';
  if (addr.group) {
    const members = addr.group.map(m => formatAddress(m)).join(', ');
    return addr.name ? `${addr.name}: ${members}` : members;
  }
  if (addr.name) return `${addr.name} <${addr.address}>`;
  return addr.address || '';
}

export function formatAddressList(addrs) {
  if (!addrs || !Array.isArray(addrs) || addrs.length === 0) return '';
  const result = addrs.map(formatAddress).filter(Boolean).join(', ');
  if (result.length > 500) return result.substring(0, 497) + '...';
  return result;
}

export function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return isoString;
  }
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function htmlToText(html) {
  if (!html) return '';
  let text = html;
  // 移除不可见内容
  text = text.replace(/<style[^>]*>.*?<\/style>/gis, '');
  text = text.replace(/<script[^>]*>.*?<\/script>/gis, '');
  text = text.replace(/<!--.*?-->/gs, '');
  // 表格结构：td 用空格分隔，tr 用换行
  text = text.replace(/<\/td>/gi, ' \t');
  text = text.replace(/<\/th>/gi, ' \t');
  text = text.replace(/<\/tr>/gi, '\n');
  // 块级元素换行
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n');
  text = text.replace(/<(p|div|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n───\n');
  // 提取链接：<a href="URL">文字</a> → 文字 (URL)
  text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi,
    (_, url, linkText) => {
      const clean = linkText.replace(/<[^>]*>/g, '').trim();
      if (!clean || clean === url || clean === url.replace(/^https?:\/\//, '')) {
        return clean || url;
      }
      return `${clean} (${url})`;
    });
  // 移除所有剩余标签
  text = text.replace(/<[^>]*>/g, '');
  // HTML 实体解码
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&mdash;/g, '—');
  text = text.replace(/&ndash;/g, '–');
  text = text.replace(/&hellip;/g, '…');
  text = text.replace(/&laquo;/g, '«');
  text = text.replace(/&raquo;/g, '»');
  text = text.replace(/&bull;/g, '•');
  text = text.replace(/&middot;/g, '·');
  text = text.replace(/&copy;/g, '©');
  text = text.replace(/&reg;/g, '®');
  text = text.replace(/&trade;/g, '™');
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  // 清理空白
  text = text.replace(/\t/g, '  ');           // tab → 双空格（表格列分隔）
  text = text.replace(/[ \t]+$/gm, '');        // 行尾空白
  text = text.replace(/^[ \t]+/gm, (m) => m.length > 4 ? '' : m); // 过长行首缩进
  text = text.replace(/[ ]{3,}/g, '  ');       // 连续空格压缩
  text = text.replace(/\n{3,}/g, '\n\n');      // 连续空行压缩
  return text.trim();
}

export function deriveWebhookSecret(botToken) {
  return botToken.replace(/[^A-Za-z0-9_-]/g, '_');
}

// ============ 随机前缀生成 ============

const ADJECTIVES = [
  'cold', 'dark', 'soft', 'wild', 'deep', 'pale', 'keen', 'calm', 'gray', 'bold',
  'warm', 'cool', 'thin', 'fast', 'slow', 'old', 'new', 'dry', 'raw', 'odd',
  'red', 'blue', 'dim', 'fair', 'fond', 'glad', 'hazy', 'icy', 'lazy', 'mild',
];
const NOUNS = [
  'moon', 'pine', 'rain', 'leaf', 'rock', 'fox', 'owl', 'bear', 'wolf', 'star',
  'lake', 'wind', 'snow', 'fire', 'dust', 'sand', 'iron', 'moss', 'reed', 'hawk',
  'fern', 'oak', 'elm', 'bay', 'ash', 'dew', 'fog', 'gem', 'hut', 'jar',
];

export function generateRandomPrefix() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 90) + 10; // 10-99
  return `${adj}${noun}${num}`;
}
