// ============ Telegram API ============

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY = 500; // ms

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, options, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, options);
      const result = await resp.json();

      if (result.ok) return result;

      // Telegram 429 Too Many Requests: 按 retry_after 等待
      if (result.error_code === 429 && attempt < MAX_RETRIES) {
        const wait = (result.parameters?.retry_after || 1) * 1000;
        console.log(`${label}: rate limited, waiting ${wait}ms (attempt ${attempt})`);
        await sleep(wait);
        continue;
      }

      // 其他 5xx 服务端错误可重试
      if (result.error_code >= 500 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`${label}: server error ${result.error_code}, retrying in ${delay}ms (attempt ${attempt})`);
        await sleep(delay);
        continue;
      }

      // 4xx 客户端错误（非 429）不重试
      console.log(`${label} error:`, JSON.stringify(result));
      return result;
    } catch (err) {
      // 网络错误可重试
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`${label}: network error, retrying in ${delay}ms (attempt ${attempt}):`, err.message);
        await sleep(delay);
        continue;
      }
      console.log(`${label}: failed after ${MAX_RETRIES} attempts:`, err.message);
      return { ok: false, error: err.message };
    }
  }
}

export async function sendTelegramMessage(env, text, replyToMessageId, options) {
  const payload = {
    chat_id: env.TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    ...options,
  };
  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'sendMessage',
  );
}

export async function sendTelegramPrompt(env, text) {
  const payload = {
    chat_id: env.TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true },
  };
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'sendPrompt',
  );
}

export async function sendTelegramPhoto(env, blob, filename, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', env.TG_CHAT_ID);
  form.append('photo', blob, filename);
  if (replyToMessageId) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  }
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`,
    { method: 'POST', body: form },
    'sendPhoto',
  );
}

export async function sendTelegramDocument(env, blob, filename, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', env.TG_CHAT_ID);
  form.append('document', blob, filename);
  if (replyToMessageId) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  }
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`,
    { method: 'POST', body: form },
    'sendDocument',
  );
}

export async function sendTelegramMediaGroup(env, mediaItems, replyToMessageId) {
  if (mediaItems.length === 0) return null;

  // sendMediaGroup 至少需要 2 个，单个时降级
  if (mediaItems.length === 1) {
    const item = mediaItems[0];
    if (item.type === 'photo') {
      return sendTelegramPhoto(env, item.blob, item.filename, replyToMessageId);
    }
    return sendTelegramDocument(env, item.blob, item.filename, replyToMessageId);
  }

  const form = new FormData();
  form.append('chat_id', env.TG_CHAT_ID);
  if (replyToMessageId) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  }

  const media = mediaItems.map((item, i) => {
    const field = `file${i}`;
    form.append(field, item.blob, item.filename || `attachment_${i}`);
    return { type: item.type, media: `attach://${field}` };
  });

  form.append('media', JSON.stringify(media));

  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMediaGroup`,
    { method: 'POST', body: form },
    'sendMediaGroup',
  );
}

export async function deleteMessage(env, messageId) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id: messageId }),
    });
  } catch { /* best effort */ }
}

export async function editMessageText(env, msgId, text, replyMarkup) {
  const payload = {
    chat_id: env.TG_CHAT_ID,
    message_id: msgId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'editMessageText',
  );
}

export async function getFileUrl(env, fileId) {
  const result = await fetchWithRetry(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) },
    'getFile',
  );
  if (!result?.ok) return null;
  return `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${result.result.file_path}`;
}

export async function downloadTelegramFile(env, fileId) {
  const url = await getFileUrl(env, fileId);
  if (!url) return null;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.text();
}

export async function answerCallbackQuery(env, callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch { /* 不影响主流程 */ }
}
