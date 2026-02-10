// ============ 编码检测与修复 ============

export const FALLBACK_CHARSETS = ['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];

export function detectGarbled(text) {
  if (!text) return false;
  return text.includes('\uFFFD');
}

// 从原始邮件字节中提取文本 body 的原始字节
export function extractRawTextBody(rawBytes) {
  // 用 latin1 解码保留所有原始字节值
  const raw = new TextDecoder('latin1').decode(rawBytes);
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headers = raw.substring(0, headerEnd);

  // 检查是否 multipart
  const boundaryMatch = headers.match(/Content-Type:\s*multipart\/\w+[^]*?boundary="?([^\s";]+)"?/i);
  if (boundaryMatch) {
    return findTextPartInMultipart(raw, rawBytes, boundaryMatch[1]);
  }

  // 单部分邮件：头部后面就是 body
  const cte = extractHeader(headers, 'Content-Transfer-Encoding');
  const bodyRaw = raw.substring(headerEnd + 4);
  return decodeTransferEncoding(bodyRaw, rawBytes.slice(headerEnd + 4), cte);
}

function findTextPartInMultipart(raw, rawBytes, boundary) {
  const sep = '--' + boundary;
  const parts = raw.split(sep);

  // 优先找 text/plain，其次 text/html
  let htmlPart = null;
  for (const part of parts) {
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) continue;

    const partHeaders = part.substring(0, hEnd);
    const ctLine = partHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!ctLine) continue;

    const ct = ctLine[1].toLowerCase();
    if (!ct.includes('text/plain') && !ct.includes('text/html')) continue;

    const cte = extractHeader(partHeaders, 'Content-Transfer-Encoding');
    const bodyStart = hEnd + 4;
    const bodyRaw = part.substring(bodyStart).replace(/\r\n--[\s\S]*$/, '').replace(/\r\n$/, '');

    // 找到此 part 在原始字节中的偏移
    const partOffset = raw.indexOf(part);
    const bodyBytes = rawBytes.slice(partOffset + bodyStart, partOffset + bodyStart + bodyRaw.length);
    const decoded = decodeTransferEncoding(bodyRaw, bodyBytes, cte);

    if (ct.includes('text/plain')) return decoded;
    if (ct.includes('text/html') && !htmlPart) htmlPart = decoded;
  }
  return htmlPart;
}

function extractHeader(headers, name) {
  const match = headers.match(new RegExp(name + ':\\s*(.+)', 'i'));
  return match ? match[1].trim() : '';
}

function decodeTransferEncoding(bodyRaw, bodyBytes, cte) {
  const encoding = (cte || '').toLowerCase();
  if (encoding.includes('base64')) {
    const clean = bodyRaw.replace(/\s/g, '');
    try {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch { return bodyBytes; }
  }
  if (encoding.includes('quoted-printable')) {
    const decoded = bodyRaw
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }
  return bodyBytes;
}

export function tryDecodeBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  for (const charset of FALLBACK_CHARSETS) {
    try {
      const decoder = new TextDecoder(charset, { fatal: true });
      const text = decoder.decode(bytes);
      if (!detectGarbled(text) && isReadableText(text)) {
        return { text, charset };
      }
    } catch { continue; }
  }
  return null;
}

export function isReadableText(text) {
  if (!text || text.length === 0) return false;
  const sample = text.substring(0, 200);
  let readable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 0x20 && c <= 0x7E) ||     // ASCII 可打印
        (c >= 0x4E00 && c <= 0x9FFF) ||  // CJK 基本
        (c >= 0x3400 && c <= 0x4DBF) ||  // CJK 扩展A
        (c >= 0x3000 && c <= 0x303F) ||  // CJK 标点
        (c >= 0xFF00 && c <= 0xFFEF) ||  // 全角字符
        c === 0x0A || c === 0x0D) {      // 换行
      readable++;
    }
  }
  return readable / sample.length > 0.6;
}

// 尝试修复乱码的正文
export function tryFixBodyEncoding(rawBytes, parsedText, parsedHtml) {
  const textGarbled = detectGarbled(parsedText);
  const htmlGarbled = detectGarbled(parsedHtml);

  if (!textGarbled && !htmlGarbled) return { text: parsedText, html: parsedHtml };

  const rawBodyBytes = extractRawTextBody(rawBytes);
  if (!rawBodyBytes) return { text: parsedText, html: parsedHtml };

  const result = tryDecodeBytes(rawBodyBytes);
  if (!result) return { text: parsedText, html: parsedHtml };

  console.log(`Encoding fallback: fixed with ${result.charset}`);

  // 修复后的文本替换掉乱码的那个
  if (textGarbled) return { text: result.text, html: parsedHtml };
  return { text: parsedText, html: result.text };
}
