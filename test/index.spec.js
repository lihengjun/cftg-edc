import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, {
	esc, formatAddress, formatAddressList, formatDate, formatSize,
	htmlToText, classifyAttachment, buildAttachmentSummary, buildNotificationText,
	detectGarbled, isReadableText, tryDecodeBytes, extractRawTextBody, tryFixBodyEncoding,
	fetchWithRetry, sleep,
	isAllowedRecipient,
	generateRandomPrefix,
	buildListText, buildListKeyboard,
	buildSettingsText, buildSettingsKeyboard,
	buildEmailActionKeyboard,
	getImageTtl, buildStrippedEml,
	calcStorageUsage, cleanExpiredEntries,
	buildStarredListText, buildStarredListKeyboard,
	searchEntries, formatDateShort, buildSearchText, buildSearchKeyboard,
	buildCompactNotificationText,
	SEARCH_PAGE_SIZE,
	checkEmailRate, RATE_WINDOW, RATE_THRESHOLD,
	MAX_STORAGE, STAR_MAX_STORAGE, EML_TTL,
	deriveWebhookSecret,
	encryptData, decryptData,
	base32Decode, generateTOTP, parseTotpInput,
	buildPwdListText, buildPwdListKeyboard, buildPwdDetailText, buildPwdDetailKeyboard, buildPwdEditKeyboard,
	buildTrashListText, buildTrashListKeyboard, buildTrashDetailText, buildTrashDetailKeyboard,
	PWD_PAGE_SIZE, PWD_TRASH_TTL,
	buildMergedSenderList, buildMgmtText, buildMgmtKeyboard,
	MGMT_PAGE_SIZE,
} from '../src';

// ============ 工具函数测试 ============

describe('esc', () => {
	it('escapes HTML special characters', () => {
		expect(esc('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
	});
	it('handles empty string', () => {
		expect(esc('')).toBe('');
	});
});

describe('formatAddress', () => {
	it('formats address with name', () => {
		expect(formatAddress({ name: 'Alice', address: 'alice@example.com' }))
			.toBe('Alice <alice@example.com>');
	});
	it('formats address without name', () => {
		expect(formatAddress({ name: '', address: 'bob@example.com' }))
			.toBe('bob@example.com');
	});
	it('formats group address', () => {
		const group = {
			name: 'Team',
			address: undefined,
			group: [
				{ name: '', address: 'a@test.com' },
				{ name: 'B', address: 'b@test.com' },
			],
		};
		expect(formatAddress(group)).toBe('Team: a@test.com, B <b@test.com>');
	});
	it('returns empty for null', () => {
		expect(formatAddress(null)).toBe('');
	});
});

describe('formatAddressList', () => {
	it('formats multiple addresses', () => {
		const addrs = [
			{ name: 'A', address: 'a@test.com' },
			{ name: '', address: 'b@test.com' },
		];
		expect(formatAddressList(addrs)).toBe('A <a@test.com>, b@test.com');
	});
	it('returns empty for null or empty', () => {
		expect(formatAddressList(null)).toBe('');
		expect(formatAddressList([])).toBe('');
	});
	it('truncates long lists', () => {
		const addrs = Array.from({ length: 50 }, (_, i) => ({
			name: `LongName${i}`,
			address: `very-long-email-address-${i}@extremely-long-domain-name.example.com`,
		}));
		const result = formatAddressList(addrs);
		expect(result.length).toBeLessThanOrEqual(500);
		expect(result).toMatch(/\.\.\.$/);
	});
});

describe('formatDate', () => {
	it('formats ISO date', () => {
		expect(formatDate('2026-02-09T12:30:00.000Z')).toBe('2026-02-09 12:30:00 UTC');
	});
	it('returns original for invalid date', () => {
		expect(formatDate('not a date')).toBe('not a date');
	});
	it('returns empty for null', () => {
		expect(formatDate(null)).toBe('');
	});
});

describe('formatSize', () => {
	it('formats bytes', () => {
		expect(formatSize(500)).toBe('500B');
	});
	it('formats KB', () => {
		expect(formatSize(2048)).toBe('2.0KB');
	});
	it('formats MB', () => {
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0MB');
	});
});

describe('htmlToText', () => {
	it('strips basic HTML tags', () => {
		expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
	});
	it('preserves links as text (URL)', () => {
		const html = '<a href="https://example.com">Click here</a>';
		expect(htmlToText(html)).toBe('Click here (https://example.com)');
	});
	it('does not duplicate URL when link text equals URL', () => {
		const html = '<a href="https://example.com">https://example.com</a>';
		expect(htmlToText(html)).toBe('https://example.com');
	});
	it('strips style and script blocks', () => {
		const html = '<style>.x{color:red}</style><script>alert(1)</script><p>ok</p>';
		expect(htmlToText(html)).toBe('ok');
	});
	it('converts br to newline', () => {
		expect(htmlToText('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3');
	});
	it('decodes HTML entities', () => {
		expect(htmlToText('&amp; &lt; &gt; &quot; &#65; &#x41;')).toBe('& < > " A A');
	});
});

// ============ 附件分类测试 ============

describe('classifyAttachment', () => {
	const maxSize = 5 * 1024 * 1024;

	it('ignores inline tracking pixels', () => {
		const att = { mimeType: 'image/png', disposition: 'inline', content: 'abc', related: false };
		// base64 'abc' = 2 bytes, under 2KB threshold
		expect(classifyAttachment(att, maxSize).action).toBe('ignore');
	});

	it('sends normal images as photo', () => {
		const content = 'A'.repeat(4000); // ~3KB
		const att = { mimeType: 'image/jpeg', disposition: 'attachment', content };
		expect(classifyAttachment(att, maxSize).action).toBe('sendPhoto');
	});

	it('sends GIF as document', () => {
		const content = 'A'.repeat(4000);
		const att = { mimeType: 'image/gif', disposition: 'attachment', content };
		expect(classifyAttachment(att, maxSize).action).toBe('sendDocument');
	});

	it('sends PDF as document', () => {
		const content = 'A'.repeat(4000);
		const att = { mimeType: 'application/pdf', disposition: 'attachment', content };
		expect(classifyAttachment(att, maxSize).action).toBe('sendDocument');
	});

	it('lists oversized files', () => {
		const content = 'A'.repeat(8 * 1024 * 1024); // > 5MB
		const att = { mimeType: 'application/pdf', disposition: 'attachment', content };
		expect(classifyAttachment(att, maxSize).action).toBe('listOnly');
	});

	it('skips attachments with no content', () => {
		const att = { mimeType: 'image/png', disposition: 'attachment', content: null };
		expect(classifyAttachment(att, maxSize).action).toBe('skip');
	});
});

describe('buildAttachmentSummary', () => {
	const maxSize = 5 * 1024 * 1024;

	it('returns empty for no attachments', () => {
		expect(buildAttachmentSummary([], maxSize)).toBe('');
		expect(buildAttachmentSummary(null, maxSize)).toBe('');
	});

	it('summarizes mixed attachments', () => {
		const atts = [
			{ mimeType: 'image/png', disposition: 'attachment', content: 'AAAA' },
			{ mimeType: 'application/pdf', disposition: 'attachment', content: 'AAAA' },
		];
		const summary = buildAttachmentSummary(atts, maxSize);
		expect(summary).toContain('1 张图片');
		expect(summary).toContain('1 个文档');
	});
});

// ============ 消息格式化测试 ============

describe('buildNotificationText', () => {
	const baseParsed = {
		from: { name: 'Alice', address: 'alice@test.com' },
		to: [{ name: '', address: 'bob@test.com' }],
		cc: null,
		bcc: null,
		replyTo: null,
		date: '2026-02-09T12:00:00.000Z',
		subject: 'Test Subject',
	};

	it('builds basic notification', () => {
		const text = buildNotificationText(baseParsed, 'alice@test.com', 'bob@test.com', 'Hello body', '');
		expect(text).toContain('新邮件');
		expect(text).toContain('Alice');
		expect(text).toContain('Test Subject');
		expect(text).toContain('Hello body');
	});

	it('includes CC when present', () => {
		const parsed = { ...baseParsed, cc: [{ name: 'Carol', address: 'carol@test.com' }] };
		const text = buildNotificationText(parsed, '', '', 'body', '');
		expect(text).toContain('抄送');
		expect(text).toContain('Carol');
	});

	it('includes date', () => {
		const text = buildNotificationText(baseParsed, '', '', 'body', '');
		expect(text).toContain('2026-02-09 12:00:00 UTC');
	});

	it('stays under Telegram limit with long body', () => {
		const longBody = 'X'.repeat(5000);
		const text = buildNotificationText(baseParsed, '', '', longBody, '');
		expect(text.length).toBeLessThanOrEqual(4096);
	});

	it('includes attachment summary', () => {
		const text = buildNotificationText(baseParsed, '', '', 'body', '附件: 2 张图片');
		expect(text).toContain('📎');
		expect(text).toContain('2 张图片');
	});
});

// ============ 编码检测与修复测试 ============

describe('detectGarbled', () => {
	it('detects replacement characters', () => {
		expect(detectGarbled('hello \uFFFD world')).toBe(true);
	});
	it('returns false for clean text', () => {
		expect(detectGarbled('正常的中文文本')).toBe(false);
	});
	it('returns false for null/empty', () => {
		expect(detectGarbled(null)).toBe(false);
		expect(detectGarbled('')).toBe(false);
	});
});

describe('isReadableText', () => {
	it('accepts Chinese text', () => {
		expect(isReadableText('这是一封测试邮件')).toBe(true);
	});
	it('accepts English text', () => {
		expect(isReadableText('This is a test email')).toBe(true);
	});
	it('accepts mixed text', () => {
		expect(isReadableText('Hello 你好 Test 测试')).toBe(true);
	});
	it('rejects empty text', () => {
		expect(isReadableText('')).toBe(false);
	});
});

describe('tryDecodeBytes', () => {
	it('decodes GBK bytes correctly', () => {
		// "你好" in GBK is: 0xC4, 0xE3, 0xBA, 0xC3
		const gbkBytes = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]);
		const result = tryDecodeBytes(gbkBytes);
		expect(result).not.toBeNull();
		expect(result.text).toBe('你好');
		expect(result.charset).toBe('gbk');
	});
	it('returns null for empty bytes', () => {
		expect(tryDecodeBytes(new Uint8Array(0))).toBeNull();
		expect(tryDecodeBytes(null)).toBeNull();
	});
});

describe('extractRawTextBody', () => {
	it('extracts body from single-part email', () => {
		const email = 'Content-Type: text/plain; charset=utf-8\r\nSubject: Test\r\n\r\nHello World';
		const bytes = new TextEncoder().encode(email);
		const result = extractRawTextBody(bytes);
		expect(result).not.toBeNull();
		const decoded = new TextDecoder().decode(result);
		expect(decoded).toBe('Hello World');
	});

	it('extracts text/plain from multipart email', () => {
		const email = [
			'Content-Type: multipart/alternative; boundary="boundary123"',
			'Subject: Test',
			'',
			'--boundary123',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Plain text body',
			'--boundary123',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>HTML body</p>',
			'--boundary123--',
		].join('\r\n');
		const bytes = new TextEncoder().encode(email);
		const result = extractRawTextBody(bytes);
		expect(result).not.toBeNull();
		const decoded = new TextDecoder().decode(result);
		expect(decoded).toBe('Plain text body');
	});

	it('handles base64 transfer encoding', () => {
		// "Hello" in base64 is "SGVsbG8="
		const email = [
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: base64',
			'',
			'SGVsbG8=',
		].join('\r\n');
		const bytes = new TextEncoder().encode(email);
		const result = extractRawTextBody(bytes);
		expect(result).not.toBeNull();
		const decoded = new TextDecoder().decode(result);
		expect(decoded).toBe('Hello');
	});
});

describe('tryFixBodyEncoding', () => {
	it('returns original text when not garbled', () => {
		const rawBytes = new Uint8Array(0);
		const result = tryFixBodyEncoding(rawBytes, '正常文本', '<p>正常</p>');
		expect(result.text).toBe('正常文本');
		expect(result.html).toBe('<p>正常</p>');
	});

	it('fixes garbled GBK text', () => {
		// 构造一个 charset 标错的 GBK 邮件
		// "你好" in GBK: 0xC4 0xE3 0xBA 0xC3
		const gbkBody = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]);
		const header = new TextEncoder().encode(
			'Content-Type: text/plain; charset=utf-8\r\nSubject: Test\r\n\r\n'
		);
		const rawBytes = new Uint8Array(header.length + gbkBody.length);
		rawBytes.set(header);
		rawBytes.set(gbkBody, header.length);

		// 模拟 postal-mime 用错误的 UTF-8 解码后产生 \uFFFD
		const garbledText = new TextDecoder('utf-8').decode(gbkBody);
		expect(detectGarbled(garbledText)).toBe(true);

		const result = tryFixBodyEncoding(rawBytes, garbledText, null);
		expect(result.text).toBe('你好');
	});
});

// ============ 重试逻辑测试 ============

describe('sleep', () => {
	it('resolves after delay', async () => {
		const start = Date.now();
		await sleep(50);
		expect(Date.now() - start).toBeGreaterThanOrEqual(40);
	});
});

describe('fetchWithRetry', () => {
	it('returns result on success', async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
		};
		try {
			const result = await fetchWithRetry('http://mock/api', { method: 'POST' }, 'test');
			expect(result.ok).toBe(true);
			expect(callCount).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('retries on 500 server error', async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			if (callCount < 3) {
				return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }));
			}
			return new Response(JSON.stringify({ ok: true, result: {} }));
		};
		try {
			const result = await fetchWithRetry('http://mock/api', { method: 'POST' }, 'test');
			expect(result.ok).toBe(true);
			expect(callCount).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('does not retry on 400 client error', async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }));
		};
		try {
			const result = await fetchWithRetry('http://mock/api', { method: 'POST' }, 'test');
			expect(result.ok).toBe(false);
			expect(callCount).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('retries on network error', async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			if (callCount < 3) throw new Error('Network timeout');
			return new Response(JSON.stringify({ ok: true, result: {} }));
		};
		try {
			const result = await fetchWithRetry('http://mock/api', { method: 'POST' }, 'test');
			expect(result.ok).toBe(true);
			expect(callCount).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ============ 前缀过滤测试 ============

describe('isAllowedRecipient', () => {
	it('allows all when both lists are empty', () => {
		expect(isAllowedRecipient('anything@example.com', [], [], {})).toBe(true);
	});
	// 纯前缀匹配（无域名限制）
	it('allows matching prefix (any domain)', () => {
		expect(isAllowedRecipient('info@example.com', ['info'], [], {})).toBe(true);
		expect(isAllowedRecipient('info@other.com', ['info'], [], {})).toBe(true);
	});
	it('rejects non-matching prefix', () => {
		expect(isAllowedRecipient('test@example.com', ['info'], [], {})).toBe(false);
	});
	// 每前缀域名限制
	it('allows when domain matches prefix restriction', () => {
		const pd = { info: ['abc.com'] };
		expect(isAllowedRecipient('info@abc.com', ['info'], [], pd)).toBe(true);
	});
	it('rejects when domain does not match prefix restriction', () => {
		const pd = { info: ['abc.com'] };
		expect(isAllowedRecipient('info@other.com', ['info'], [], pd)).toBe(false);
	});
	it('allows any domain when prefix has no domain restriction', () => {
		const pd = { admin: ['abc.com'] }; // info 没有域名限制
		expect(isAllowedRecipient('info@any.com', ['info', 'admin'], [], pd)).toBe(true);
	});
	it('supports multiple domains per prefix', () => {
		const pd = { info: ['abc.com', 'xyz.com'] };
		expect(isAllowedRecipient('info@abc.com', ['info'], [], pd)).toBe(true);
		expect(isAllowedRecipient('info@xyz.com', ['info'], [], pd)).toBe(true);
		expect(isAllowedRecipient('info@other.com', ['info'], [], pd)).toBe(false);
	});
	// 暂停规则不匹配
	it('does not match paused rules', () => {
		expect(isAllowedRecipient('info@example.com', [], ['info'], {})).toBe(false);
	});
	it('is case-insensitive', () => {
		expect(isAllowedRecipient('INFO@ABC.COM', ['info'], [], { info: ['abc.com'] })).toBe(true);
	});
	// prefixDomains 缺失时降级
	it('works when prefixDomains is undefined', () => {
		expect(isAllowedRecipient('info@any.com', ['info'], [])).toBe(true);
	});
});

// ============ UI 构建函数测试 ============

describe('buildListText', () => {
	it('shows empty message when no rules', () => {
		const text = buildListText([], [], {}, false, []);
		expect(text).toContain('未设置过滤');
	});
	it('shows active prefixes with checkmark', () => {
		const text = buildListText(['info', 'admin'], [], {}, false, []);
		expect(text).toContain('✅ info');
		expect(text).toContain('✅ admin');
	});
	it('shows paused prefixes', () => {
		const text = buildListText([], ['info'], {}, false, []);
		expect(text).toContain('⏸️ info');
		expect(text).toContain('已暂停');
	});
	it('shows domain restrictions with @ prefix', () => {
		const pd = { info: ['abc.com', 'xyz.com'] };
		const text = buildListText(['info'], [], pd, false, []);
		expect(text).toContain('@abc.com');
		expect(text).toContain('@xyz.com');
	});
	it('shows global mute indicator', () => {
		const text = buildListText(['info'], [], {}, true, []);
		expect(text).toContain('🔇');
		expect(text).toContain('全局静音');
	});
	it('shows muted prefix indicator', () => {
		const text = buildListText(['info', 'admin'], [], {}, false, ['info']);
		expect(text).toContain('✅ info');
		expect(text).toMatch(/info.*🔇/);
		expect(text).not.toMatch(/admin.*🔇/);
	});
	it('shows storage info at bottom', () => {
		const si = { used: 50 * 1024 * 1024, total: 300 * 1024 * 1024 };
		const text = buildListText(['info'], [], {}, false, [], si);
		expect(text).toContain('💾');
		expect(text).toContain('50.0MB');
		expect(text).toContain('300.0MB');
	});
	it('shows storage warning when over 80%', () => {
		const si = { used: 250 * 1024 * 1024, total: 300 * 1024 * 1024 };
		const text = buildListText(['info'], [], {}, false, [], si);
		expect(text).toContain('⚠️');
	});
	it('shows storage info even when no rules', () => {
		const si = { used: 10 * 1024 * 1024, total: 300 * 1024 * 1024 };
		const text = buildListText([], [], {}, false, [], si);
		expect(text).toContain('💾');
	});
});

describe('buildListKeyboard', () => {
	it('has add and random buttons when empty', () => {
		const kb = buildListKeyboard([], [], false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('add');
		expect(allData).toContain('random');
	});
	it('has pause_all when active rules exist', () => {
		const kb = buildListKeyboard(['info'], [], false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('pause_all');
	});
	it('has resume_all when only paused rules', () => {
		const kb = buildListKeyboard([], ['info'], false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('resume_all');
	});
	it('has settings button per prefix', () => {
		const kb = buildListKeyboard(['info', 'admin'], [], false);
		expect(kb.inline_keyboard[0][1].callback_data).toBe('settings:info');
		expect(kb.inline_keyboard[1][1].callback_data).toBe('settings:admin');
	});
	it('shows global mute toggle', () => {
		const kb1 = buildListKeyboard([], [], false);
		const allData1 = kb1.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData1).toContain('global_mute');

		const kb2 = buildListKeyboard([], [], true);
		const allData2 = kb2.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData2).toContain('global_unmute');
	});
	it('always shows management button', () => {
		const kb = buildListKeyboard(['info'], [], false, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('em');
		const btn = kb.inline_keyboard.flat().find(b => b.callback_data === 'em');
		expect(btn.text).toBe('📧 邮箱管理');
	});
	it('shows management button even when no storage', () => {
		const kb = buildListKeyboard([], [], false, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('em');
	});
	it('shows starred list button when starredCount > 0', () => {
		const kb = buildListKeyboard(['info'], [], false, 3);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('starlist');
		const btn = kb.inline_keyboard.flat().find(b => b.callback_data === 'starlist');
		expect(btn.text).toContain('3');
	});
	it('hides starred list button when starredCount is 0', () => {
		const kb = buildListKeyboard(['info'], [], false, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).not.toContain('starlist');
	});
});

describe('buildSettingsText', () => {
	it('shows prefix name', () => {
		const text = buildSettingsText('info', [], false, false);
		expect(text).toContain('info');
		expect(text).toContain('所有');
	});
	it('shows domain list with @ prefix', () => {
		const text = buildSettingsText('info', ['abc.com'], false, false);
		expect(text).toContain('@abc.com');
	});
	it('shows delete confirmation', () => {
		const text = buildSettingsText('info', [], true, false);
		expect(text).toContain('确认要删除');
	});
	it('shows muted indicator', () => {
		const text = buildSettingsText('info', [], false, true);
		expect(text).toContain('🔇');
	});
	it('shows domain delete confirmation', () => {
		const text = buildSettingsText('info', ['abc.com'], false, false, 'abc.com');
		expect(text).toContain('确认要删除域名');
		expect(text).toContain('@abc.com');
	});
});

describe('buildSettingsKeyboard', () => {
	it('has add domain, mute, and delete buttons', () => {
		const kb = buildSettingsKeyboard('info', [], false, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('add_domain:info');
		expect(allData).toContain('mute_prefix:info');
		expect(allData).toContain('del:info');
		expect(allData).toContain('back');
	});
	it('shows unmute button when muted', () => {
		const kb = buildSettingsKeyboard('info', [], false, true);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('unmute_prefix:info');
	});
	it('shows confirm/cancel when deleting', () => {
		const kb = buildSettingsKeyboard('info', [], true, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('confirm_del:info');
		expect(allData).toContain('settings:info'); // cancel
	});
	it('lists domains with @ prefix and remove buttons', () => {
		const kb = buildSettingsKeyboard('info', ['abc.com'], false, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('rm_domain:info:abc.com');
		const domainBtn = kb.inline_keyboard.flat().find(b => b.callback_data === 'noop');
		expect(domainBtn.text).toBe('@abc.com');
	});
	it('shows confirm/cancel for confirmRmDomain', () => {
		const kb = buildSettingsKeyboard('info', ['abc.com', 'xyz.com'], false, false, 'abc.com');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('confirm_rm_domain:info:abc.com');
		expect(allData).toContain('settings:info'); // cancel
		expect(allData).not.toContain('rm_domain:info:abc.com');
		// xyz.com should be normal
		expect(allData).toContain('rm_domain:info:xyz.com');
	});
});

// ============ 随机前缀测试 ============

describe('generateRandomPrefix', () => {
	it('generates a string with adj+noun+number pattern', () => {
		const prefix = generateRandomPrefix();
		expect(prefix).toMatch(/^[a-z]+[a-z]+\d{2}$/);
		expect(prefix.length).toBeGreaterThanOrEqual(7); // shortest: "old" + "bay" + "10"
	});
	it('generates different values', () => {
		const set = new Set();
		for (let i = 0; i < 20; i++) set.add(generateRandomPrefix());
		expect(set.size).toBeGreaterThan(10);
	});
});

// ============ 邮件通知按钮测试 ============

describe('buildEmailActionKeyboard', () => {
	it('shows eml, star, mute and block buttons by default', () => {
		const kb = buildEmailActionKeyboard(123, false, false, 0, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('eml:123');
		expect(allData).toContain('ms:123');
		expect(allData).toContain('bs:123');
		expect(allData).toContain('star:123');
		expect(allData).not.toContain('att:123'); // no attachments
		expect(allData).not.toContain('del_email:123'); // no attachments to delete
	});
	it('shows attachment and del_email buttons when attCount > 0', () => {
		const kb = buildEmailActionKeyboard(123, false, false, 3, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('att:123');
		expect(allData).toContain('eml:123');
		expect(allData).toContain('del_email:123');
		const attBtn = kb.inline_keyboard.flat().find(b => b.callback_data === 'att:123');
		expect(attBtn.text).toContain('3');
		const delBtn = kb.inline_keyboard.flat().find(b => b.callback_data === 'del_email:123');
		expect(delBtn.text).toContain('删除附件');
	});
	it('shows unmute when sender is muted', () => {
		const kb = buildEmailActionKeyboard(123, true, false, 0, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('us:123');
		expect(allData).not.toContain('ms:123');
	});
	it('shows unblock when sender is blocked', () => {
		const kb = buildEmailActionKeyboard(123, false, true, 0, false);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('ubs:123');
		expect(allData).not.toContain('bs:123');
	});
	it('shows unstar when starred', () => {
		const kb = buildEmailActionKeyboard(123, false, false, 0, true);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('unstar:123');
		expect(allData).not.toContain('star:123');
	});
});

// ============ 存储管理测试 ============

describe('getImageTtl', () => {
	it('returns 60d for images <1MB', () => {
		expect(getImageTtl(500 * 1024)).toBe(5184000);
		expect(getImageTtl(1024)).toBe(5184000);
	});
	it('returns 30d for images 1-2MB', () => {
		expect(getImageTtl(1.5 * 1024 * 1024)).toBe(2592000);
	});
	it('returns 15d for images 2-5MB', () => {
		expect(getImageTtl(3 * 1024 * 1024)).toBe(1296000);
	});
	it('returns 7d for images >5MB', () => {
		expect(getImageTtl(10 * 1024 * 1024)).toBe(604800);
	});
	it('boundary: exactly 1MB returns 60d', () => {
		expect(getImageTtl(1 * 1024 * 1024)).toBe(5184000);
	});
	it('boundary: exactly 2MB returns 30d', () => {
		expect(getImageTtl(2 * 1024 * 1024)).toBe(2592000);
	});
	it('boundary: exactly 5MB returns 15d', () => {
		expect(getImageTtl(5 * 1024 * 1024)).toBe(1296000);
	});
});

describe('buildStrippedEml', () => {
	it('returns single-part email as-is', () => {
		const email = 'Content-Type: text/plain; charset=utf-8\r\nSubject: Test\r\n\r\nHello World';
		const bytes = new TextEncoder().encode(email);
		const result = buildStrippedEml(bytes);
		expect(new TextDecoder().decode(result)).toBe(email);
	});

	it('strips binary attachments from multipart email', () => {
		const email = [
			'Content-Type: multipart/mixed; boundary="b1"',
			'Subject: Test',
			'',
			'--b1',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Hello body',
			'--b1',
			'Content-Type: image/png',
			'Content-Disposition: attachment; filename="test.png"',
			'',
			'FAKE_IMAGE_DATA_HERE',
			'--b1--',
		].join('\r\n');
		const bytes = new TextEncoder().encode(email);
		const result = buildStrippedEml(bytes);
		const text = new TextDecoder().decode(result);
		expect(text).toContain('Hello body');
		expect(text).toContain('[attachment removed]');
		expect(text).not.toContain('FAKE_IMAGE_DATA_HERE');
	});

	it('preserves text/html parts', () => {
		const email = [
			'Content-Type: multipart/alternative; boundary="b2"',
			'',
			'--b2',
			'Content-Type: text/plain',
			'',
			'Plain text',
			'--b2',
			'Content-Type: text/html',
			'',
			'<p>HTML text</p>',
			'--b2--',
		].join('\r\n');
		const bytes = new TextEncoder().encode(email);
		const result = buildStrippedEml(bytes);
		const text = new TextDecoder().decode(result);
		expect(text).toContain('Plain text');
		expect(text).toContain('<p>HTML text</p>');
	});

	it('handles ArrayBuffer input', () => {
		const email = 'Content-Type: text/plain\r\n\r\nTest';
		const buf = new TextEncoder().encode(email).buffer;
		const result = buildStrippedEml(buf);
		expect(new TextDecoder().decode(result)).toBe(email);
	});
});

describe('calcStorageUsage', () => {
	it('returns 0 for empty index', () => {
		expect(calcStorageUsage({ entries: [], totalSize: 0 })).toBe(0);
	});
	it('sums textSize and image sizes', () => {
		const index = {
			entries: [
				{ id: 1, ts: 0, textSize: 1000, images: [{ idx: 0, size: 2000, ttl: 604800 }] },
				{ id: 2, ts: 0, textSize: 500, images: [] },
			],
			totalSize: 3500,
		};
		expect(calcStorageUsage(index)).toBe(3500);
	});
	it('handles entries with no images array', () => {
		const index = {
			entries: [{ id: 1, ts: 0, textSize: 1000 }],
			totalSize: 1000,
		};
		expect(calcStorageUsage(index)).toBe(1000);
	});
});

describe('cleanExpiredEntries', () => {
	it('removes fully expired non-starred entries', () => {
		const now = Date.now();
		const index = {
			entries: [
				{
					id: 1, ts: now - (EML_TTL + 1) * 1000, starred: false,
					textSize: 1000, images: [{ idx: 0, size: 500, ttl: 604800 }],
				},
			],
			totalSize: 1500,
		};
		const removed = cleanExpiredEntries(index);
		expect(removed.length).toBe(1);
		expect(removed[0].id).toBe(1);
		expect(index.entries.length).toBe(0);
		expect(index.totalSize).toBe(0);
	});
	it('keeps starred entries even if expired', () => {
		const now = Date.now();
		const index = {
			entries: [
				{
					id: 1, ts: now - (EML_TTL + 1) * 1000, starred: true,
					textSize: 1000, images: [],
				},
			],
			totalSize: 1000,
		};
		const removed = cleanExpiredEntries(index);
		expect(removed.length).toBe(0);
		expect(index.entries.length).toBe(1);
	});
	it('keeps entries with unexpired images', () => {
		const now = Date.now();
		const index = {
			entries: [
				{
					id: 1, ts: now - 1000, starred: false,
					textSize: 100, images: [{ idx: 0, size: 500, ttl: 5184000 }],
				},
			],
			totalSize: 600,
		};
		const removed = cleanExpiredEntries(index);
		expect(removed.length).toBe(0);
		expect(index.entries.length).toBe(1);
	});
	it('returns empty array when nothing to clean', () => {
		const index = { entries: [], totalSize: 0 };
		expect(cleanExpiredEntries(index)).toEqual([]);
	});
});

describe('buildStarredListText', () => {
	it('shows empty message when no starred', () => {
		const text = buildStarredListText([], {});
		expect(text).toContain('没有收藏');
	});
	it('shows starred email info', () => {
		const entries = [
			{ id: 100, ts: Date.now() - 86400000, starred: true, textSize: 500, images: [{ idx: 0, size: 10000, ttl: 5184000 }] },
		];
		const metaMap = { 100: { subject: 'Test Subject', sender: 'alice@test.com' } };
		const text = buildStarredListText(entries, metaMap);
		expect(text).toContain('★');
		expect(text).toContain('Test Subject');
		expect(text).toContain('alice@test.com');
		expect(text).toContain('1 张图片');
		expect(text).toContain('收藏占用');
	});
	it('handles missing meta gracefully', () => {
		const entries = [
			{ id: 200, ts: Date.now(), starred: true, textSize: 100, images: [] },
		];
		const text = buildStarredListText(entries, {});
		expect(text).toContain('(无主题)');
	});
});

describe('buildStarredListKeyboard', () => {
	it('has back button', () => {
		const kb = buildStarredListKeyboard([]);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('back');
	});
	it('has view and del_att buttons per entry', () => {
		const entries = [
			{ id: 100, ts: 0, starred: true, textSize: 0, images: [] },
			{ id: 200, ts: 0, starred: true, textSize: 0, images: [] },
		];
		const kb = buildStarredListKeyboard(entries);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('view_star:100');
		expect(allData).toContain('del_att:100');
		expect(allData).toContain('view_star:200');
		expect(allData).toContain('del_att:200');
		expect(allData).toContain('back');
	});
	it('shows confirm/cancel for confirmDelId entry', () => {
		const entries = [
			{ id: 100, ts: 0, starred: true, textSize: 0, images: [] },
			{ id: 200, ts: 0, starred: true, textSize: 0, images: [] },
		];
		const kb = buildStarredListKeyboard(entries, 100);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		// entry 100 should show confirm/cancel
		expect(allData).toContain('confirm_del_att:100');
		expect(allData).toContain('starlist'); // cancel
		expect(allData).not.toContain('view_star:100');
		expect(allData).not.toContain('del_att:100');
		// confirm button should say "删除邮件"
		const confirmBtn = kb.inline_keyboard.flat().find(b => b.callback_data === 'confirm_del_att:100');
		expect(confirmBtn.text).toContain('删除邮件');
		// entry 200 should be normal with "删除邮件" label
		expect(allData).toContain('view_star:200');
		expect(allData).toContain('del_att:200');
		const delBtn = kb.inline_keyboard.flat().find(b => b.callback_data === 'del_att:200');
		expect(delBtn.text).toContain('删除邮件');
	});
});

describe('storage constants', () => {
	it('MAX_STORAGE is 300MB', () => {
		expect(MAX_STORAGE).toBe(300 * 1024 * 1024);
	});
	it('STAR_MAX_STORAGE is 50MB', () => {
		expect(STAR_MAX_STORAGE).toBe(50 * 1024 * 1024);
	});
	it('EML_TTL is 60 days', () => {
		expect(EML_TTL).toBe(60 * 86400);
	});
});

// ============ Worker Handler 测试 ============

describe('cftg-edc', () => {
	it('GET returns status message', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe('Email-to-Telegram worker is running.');
	});

	it('POST with invalid JSON returns 400', async () => {
		const secret = deriveWebhookSecret(env.TG_BOT_TOKEN);
		const request = new Request('http://example.com', {
			method: 'POST',
			body: 'not json',
			headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('POST with no message returns OK', async () => {
		const secret = deriveWebhookSecret(env.TG_BOT_TOKEN);
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Telegram-Bot-Api-Secret-Token': secret,
			},
			body: JSON.stringify({ update_id: 123 }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe('OK');
	});
});

// ============ 搜索功能测试 ============

describe('searchEntries', () => {
	const entries = [
		{ id: 1, ts: 1000, sender: 'alice@example.com', subject: '订单确认', starred: false },
		{ id: 2, ts: 2000, sender: 'bob@test.com', subject: 'Meeting Tomorrow', starred: true },
		{ id: 3, ts: 3000, sender: 'admin@example.com', subject: '账号验证码', starred: false },
		{ id: 4, ts: 4000, sender: 'charlie@shop.com', subject: 'Order Shipped', starred: false },
		{ id: 5, ts: 5000, subject: '无发件人邮件', starred: false },
	];

	it('matches sender by keyword', () => {
		const results = searchEntries(entries, 'alice');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe(1);
	});
	it('matches subject by keyword', () => {
		const results = searchEntries(entries, '订单');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe(1);
	});
	it('matches case-insensitively', () => {
		const results = searchEntries(entries, 'meeting');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe(2);
	});
	it('matches multiple results', () => {
		const results = searchEntries(entries, 'example.com');
		expect(results.length).toBe(2);
	});
	it('returns empty for no match', () => {
		expect(searchEntries(entries, 'zzzzz').length).toBe(0);
	});
	it('handles entries without sender', () => {
		const results = searchEntries(entries, '无发件人');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe(5);
	});
});

describe('formatDateShort', () => {
	it('formats timestamp to month/day', () => {
		const ts = new Date(2026, 1, 9).getTime(); // Feb 9
		expect(formatDateShort(ts)).toBe('2月9日');
	});
});

describe('buildSearchText', () => {
	it('shows no results message', () => {
		const text = buildSearchText('xyz', [], 0);
		expect(text).toContain('共 0 条');
		expect(text).toContain('没有找到');
	});
	it('shows results with sender and subject', () => {
		const results = [
			{ id: 1, ts: Date.now(), sender: 'alice@test.com', subject: '测试邮件', starred: false },
		];
		const text = buildSearchText('测试', results, 0);
		expect(text).toContain('共 1 条');
		expect(text).toContain('alice@test.com');
		expect(text).toContain('测试邮件');
	});
	it('shows pagination info when multiple pages', () => {
		const results = Array.from({ length: 12 }, (_, i) => ({
			id: i, ts: Date.now(), sender: `user${i}@test.com`, subject: `Subject ${i}`, starred: false,
		}));
		const text = buildSearchText('user', results, 1);
		expect(text).toContain('第 2/3 页');
		expect(text).toContain('共 12 条');
	});
	it('shows star icon for starred entries', () => {
		const results = [
			{ id: 1, ts: Date.now(), sender: 'a@b.com', subject: 'S', starred: true },
		];
		const text = buildSearchText('a', results, 0);
		expect(text).toContain('⭐');
	});
});

describe('buildSearchKeyboard', () => {
	it('shows back button for empty results', () => {
		const kb = buildSearchKeyboard([], 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('back');
		expect(allData.length).toBe(1);
	});
	it('shows view buttons for results', () => {
		const results = [
			{ id: 100, ts: 0 }, { id: 200, ts: 0 },
		];
		const kb = buildSearchKeyboard(results, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('search_view:100');
		expect(allData).toContain('search_view:200');
		expect(allData).toContain('back');
	});
	it('shows pagination buttons when needed', () => {
		const results = Array.from({ length: 12 }, (_, i) => ({ id: i, ts: 0 }));
		const kb0 = buildSearchKeyboard(results, 0);
		const data0 = kb0.inline_keyboard.flat().map(b => b.callback_data);
		expect(data0).toContain('search_page:1');
		expect(data0).not.toContain('search_page:-1');

		const kb1 = buildSearchKeyboard(results, 1);
		const data1 = kb1.inline_keyboard.flat().map(b => b.callback_data);
		expect(data1).toContain('search_page:0');
		expect(data1).toContain('search_page:2');
	});
	it('no pagination for single page', () => {
		const results = [{ id: 1, ts: 0 }];
		const kb = buildSearchKeyboard(results, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).not.toContain('search_page:0');
		expect(allData).not.toContain('search_page:1');
	});
});

// ============ 精简通知测试 ============

describe('buildCompactNotificationText', () => {
	it('builds compact text with sender, subject and time', () => {
		const parsed = {
			from: { name: 'Alice', address: 'alice@test.com' },
			subject: 'Hello World',
			date: '2026-01-15T10:30:00Z',
			to: [{ address: 'me@domain.com' }],
		};
		const text = buildCompactNotificationText(parsed, 'alice@test.com', 'me@domain.com');
		expect(text).toContain('📧');
		expect(text).toContain('Alice');
		expect(text).toContain('Hello World');
		expect(text).toContain('me@domain.com');
	});
	it('handles missing subject', () => {
		const parsed = { from: { address: 'bob@test.com' }, to: [] };
		const text = buildCompactNotificationText(parsed, 'bob@test.com', 'me@domain.com');
		expect(text).toContain('(无主题)');
	});
	it('handles missing date', () => {
		const parsed = { from: { address: 'bob@test.com' }, subject: 'Hi', to: [] };
		const text = buildCompactNotificationText(parsed, 'bob@test.com', 'me@domain.com');
		expect(text).not.toContain(' - ');
		expect(text).toContain('Hi');
	});
});

describe('checkEmailRate', () => {
	it('returns false on first call (normal mode)', async () => {
		const mockKV = {
			get: async () => null,
			put: async () => {},
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(false); // 只有 1 条，远低于阈值
	});
	it('returns false when timestamps within threshold', async () => {
		const now = Date.now();
		// 窗口内 8 条 + 当前 1 条 = 9 条，<= 10
		const timestamps = Array.from({ length: 8 }, (_, i) => now - i * 10000);
		const mockKV = {
			get: async () => JSON.stringify(timestamps),
			put: async () => {},
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(false);
	});
	it('returns true when timestamps exceed threshold', async () => {
		const now = Date.now();
		// 窗口内 10 条 + 当前 1 条 = 11 条，> 10
		const timestamps = Array.from({ length: RATE_THRESHOLD }, (_, i) => now - i * 10000);
		const mockKV = {
			get: async () => JSON.stringify(timestamps),
			put: async () => {},
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(true);
	});
	it('filters out expired timestamps', async () => {
		const now = Date.now();
		// 20 条全部在窗口外
		const oldTimestamps = Array.from({ length: 20 }, (_, i) => now - RATE_WINDOW - 1000 - i * 1000);
		const mockKV = {
			get: async () => JSON.stringify(oldTimestamps),
			put: async () => {},
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(false); // 清理后只剩当前 1 条
	});
	it('mixed old and new timestamps', async () => {
		const now = Date.now();
		// 5 条在窗口内 + 10 条在窗口外 → 清理后 5 + 1 = 6 条
		const recent = Array.from({ length: 5 }, (_, i) => now - i * 10000);
		const old = Array.from({ length: 10 }, (_, i) => now - RATE_WINDOW - 1000 - i * 1000);
		const mockKV = {
			get: async () => JSON.stringify([...recent, ...old]),
			put: async () => {},
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(false); // 6 <= 10
	});
	it('returns false on KV error', async () => {
		const mockKV = {
			get: async () => { throw new Error('KV down'); },
		};
		const result = await checkEmailRate({ MAIL_CONFIG: mockKV });
		expect(result).toBe(false);
	});
});

describe('rate limiting constants', () => {
	it('RATE_WINDOW is 5 minutes', () => {
		expect(RATE_WINDOW).toBe(300000);
	});
	it('RATE_THRESHOLD is 10', () => {
		expect(RATE_THRESHOLD).toBe(10);
	});
});

// ============ Webhook 安全测试 ============

describe('deriveWebhookSecret', () => {
	it('replaces non-alphanumeric characters', () => {
		const secret = deriveWebhookSecret('123456:ABC-DEF_test');
		expect(secret).toBe('123456_ABC-DEF_test');
		expect(secret).not.toContain(':');
	});
	it('preserves valid characters', () => {
		const secret = deriveWebhookSecret('abc-DEF_123');
		expect(secret).toBe('abc-DEF_123');
	});
	it('returns consistent results', () => {
		const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
		expect(deriveWebhookSecret(token)).toBe(deriveWebhookSecret(token));
	});
});

describe('webhook POST authentication', () => {
	it('rejects POST without secret header', async () => {
		const request = new Request('https://example.com/', { method: 'POST', body: '{}' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});
	it('rejects POST with wrong secret', async () => {
		const request = new Request('https://example.com/', {
			method: 'POST',
			body: '{}',
			headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});
});

// ============ 密码管理测试 ============

describe('encryptData / decryptData', () => {
	it('encrypts and decrypts correctly', async () => {
		const testEnv = { PWD_KEY: 'a'.repeat(64) };
		const plaintext = '{"username":"test","password":"p@ss!"}';
		const encrypted = await encryptData(testEnv, plaintext);
		expect(encrypted).toHaveProperty('iv');
		expect(encrypted).toHaveProperty('data');
		expect(encrypted.iv).not.toBe('');
		expect(encrypted.data).not.toBe('');
		const decrypted = await decryptData(testEnv, encrypted);
		expect(decrypted).toBe(plaintext);
	});
	it('produces different ciphertext for same plaintext (random IV)', async () => {
		const testEnv = { PWD_KEY: 'b'.repeat(64) };
		const plaintext = 'hello world';
		const enc1 = await encryptData(testEnv, plaintext);
		const enc2 = await encryptData(testEnv, plaintext);
		expect(enc1.iv).not.toBe(enc2.iv);
		expect(enc1.data).not.toBe(enc2.data);
		expect(await decryptData(testEnv, enc1)).toBe(plaintext);
		expect(await decryptData(testEnv, enc2)).toBe(plaintext);
	});
	it('handles unicode and multi-line text', async () => {
		const testEnv = { PWD_KEY: 'c'.repeat(64) };
		const plaintext = '用户名: 测试\n密码: Pässwörd123\n备注: https://example.com';
		const encrypted = await encryptData(testEnv, plaintext);
		const decrypted = await decryptData(testEnv, encrypted);
		expect(decrypted).toBe(plaintext);
	});
});

describe('buildPwdListText', () => {
	it('shows empty message', () => {
		const text = buildPwdListText([], 0);
		expect(text).toContain('密码列表为空');
	});
	it('shows count and page info', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `site${i}`, ts: i }));
		const text = buildPwdListText(list, 1);
		expect(text).toContain('20 条');
		expect(text).toContain('2/3');
	});
	it('single page has no page info', () => {
		const list = [{ name: 'test', ts: 1 }];
		const text = buildPwdListText(list, 0);
		expect(text).toContain('1 条');
		expect(text).not.toContain('/');
	});
});

describe('buildPwdListKeyboard', () => {
	it('creates buttons for each item with add button on page 0', () => {
		const list = [{ name: 'github', ts: 1 }, { name: 'aws', ts: 2 }];
		const kb = buildPwdListKeyboard(list, 0);
		expect(kb.inline_keyboard.length).toBe(3); // 2 items + bottom row
		expect(kb.inline_keyboard[0][0].text).toBe('github');
		expect(kb.inline_keyboard[0][0].callback_data).toBe('pv:github');
		const bottomRow = kb.inline_keyboard[2];
		expect(bottomRow.some(b => b.callback_data === 'pa')).toBe(true);
	});
	it('paginates correctly with add button on first page', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, ts: i }));
		const kb = buildPwdListKeyboard(list, 0);
		// 8 items + 1 bottom row (add + nav)
		expect(kb.inline_keyboard.length).toBe(PWD_PAGE_SIZE + 1);
		const bottomRow = kb.inline_keyboard[PWD_PAGE_SIZE];
		expect(bottomRow.some(b => b.callback_data === 'pa')).toBe(true);
		expect(bottomRow.some(b => b.callback_data === 'pp:1')).toBe(true);
	});
	it('no add button on page 1', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, ts: i }));
		const kb = buildPwdListKeyboard(list, 1);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pa')).toBe(false);
		expect(btns.some(b => b.callback_data === 'pp:0')).toBe(true);
		expect(btns.some(b => b.callback_data === 'pp:2')).toBe(true);
	});
});

describe('buildPwdDetailText', () => {
	const entry = { username: 'user@test.com', password: 'S3cret!', note: 'https://example.com\n备注' };
	it('hides password by default', () => {
		const text = buildPwdDetailText('github', entry, false);
		expect(text).toContain('github');
		expect(text).toContain('<code>user@test.com</code>');
		expect(text).toContain('••••••••••');
		expect(text).not.toContain('S3cret!');
		expect(text).toContain('https://example.com');
	});
	it('shows password when requested', () => {
		const text = buildPwdDetailText('github', entry, true);
		expect(text).toContain('<code>S3cret!</code>');
		expect(text).not.toContain('••••••••••');
		expect(text).toContain('30秒后自动隐藏');
	});
	it('escapes HTML in values', () => {
		const e = { username: '<script>alert(1)</script>', password: 'a&b', note: '' };
		const text = buildPwdDetailText('test', e, true);
		expect(text).toContain('&lt;script&gt;');
		expect(text).toContain('a&amp;b');
	});
	it('omits empty fields', () => {
		const e = { username: '', password: '', note: '' };
		const text = buildPwdDetailText('test', e, false);
		expect(text).not.toContain('👤');
		expect(text).not.toContain('🔑');
		expect(text).not.toContain('📝');
		expect(text).toContain('🔐');
	});
	it('shows only filled fields', () => {
		const e = { username: '', password: '', note: '备忘' };
		const text = buildPwdDetailText('test', e, false);
		expect(text).not.toContain('👤');
		expect(text).not.toContain('🔑');
		expect(text).toContain('📝 备忘');
	});
});

describe('buildPwdDetailKeyboard', () => {
	it('shows show password button when has password', () => {
		const kb = buildPwdDetailKeyboard('github', false, false, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ps:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ph:github')).toBe(false);
	});
	it('shows hide button when showing', () => {
		const kb = buildPwdDetailKeyboard('github', true, false, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ph:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ps:github')).toBe(false);
	});
	it('hides show/hide buttons when no password', () => {
		const kb = buildPwdDetailKeyboard('github', false, false, false);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ps:github')).toBe(false);
		expect(btns.some(b => b.callback_data === 'ph:github')).toBe(false);
		expect(btns.some(b => b.callback_data === 'pe:github')).toBe(true);
	});
	it('shows confirm delete when requested', () => {
		const kb = buildPwdDetailKeyboard('github', false, true, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pcd:github')).toBe(true);
	});
	it('has back button', () => {
		const kb = buildPwdDetailKeyboard('github', false, false, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pb')).toBe(true);
	});
});

describe('buildPwdEditKeyboard', () => {
	it('has all 5 field buttons', () => {
		const kb = buildPwdEditKeyboard('github');
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'peu:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'pep:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'pen:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'pet:github')).toBe(true);
		expect(btns.some(b => b.callback_data === 'prn:github')).toBe(true);
	});
	it('has back to detail button', () => {
		const kb = buildPwdEditKeyboard('github');
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pv:github')).toBe(true);
	});
});

// ============ TOTP 测试 ============

describe('base32Decode', () => {
	it('decodes standard base32', () => {
		// "JBSWY3DPEE" is base32 for "Hello!"
		const bytes = base32Decode('JBSWY3DPEE');
		const str = new TextDecoder().decode(bytes);
		expect(str).toBe('Hello!');
	});
	it('handles lowercase and spaces', () => {
		const bytes = base32Decode('jbsw y3dp ee');
		const str = new TextDecoder().decode(bytes);
		expect(str).toBe('Hello!');
	});
	it('handles padding', () => {
		const bytes = base32Decode('JBSWY3DPEE======');
		const str = new TextDecoder().decode(bytes);
		expect(str).toBe('Hello!');
	});
});

describe('generateTOTP', () => {
	it('generates 6-digit code', async () => {
		// RFC 6238 test secret
		const code = await generateTOTP('JBSWY3DPEHPK3PXP');
		expect(code).toMatch(/^\d{6}$/);
	});
	it('generates consistent code for same time window', async () => {
		const code1 = await generateTOTP('JBSWY3DPEHPK3PXP');
		const code2 = await generateTOTP('JBSWY3DPEHPK3PXP');
		expect(code1).toBe(code2);
	});
});

describe('parseTotpInput', () => {
	it('parses raw base32 secret', () => {
		expect(parseTotpInput('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
	});
	it('parses otpauth URI', () => {
		expect(parseTotpInput('otpauth://totp/Example:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example'))
			.toBe('JBSWY3DPEHPK3PXP');
	});
	it('normalizes lowercase to uppercase', () => {
		expect(parseTotpInput('jbswy3dpehpk3pxp')).toBe('JBSWY3DPEHPK3PXP');
	});
	it('rejects too short input', () => {
		expect(parseTotpInput('ABC')).toBeNull();
	});
	it('rejects invalid characters', () => {
		expect(parseTotpInput('not-a-valid-key!!')).toBeNull();
	});
});

describe('buildPwdDetailText with totp', () => {
	it('shows 2FA indicator when totp is set', () => {
		const entry = { username: 'user', password: 'pass', note: '', totp: 'JBSWY3DPEHPK3PXP' };
		const text = buildPwdDetailText('test', entry, false);
		expect(text).toContain('🔢 2FA 已启用');
	});
	it('hides 2FA indicator when totp is empty', () => {
		const entry = { username: 'user', password: 'pass', note: '', totp: '' };
		const text = buildPwdDetailText('test', entry, false);
		expect(text).not.toContain('🔢');
	});
});

describe('buildPwdDetailKeyboard with totp', () => {
	it('shows TOTP button when hasTotp is true', () => {
		const kb = buildPwdDetailKeyboard('test', false, false, true, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pt:test')).toBe(true);
	});
	it('hides TOTP button when hasTotp is false', () => {
		const kb = buildPwdDetailKeyboard('test', false, false, true, false);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pt:test')).toBe(false);
	});
});

// ============ 邮箱管理页测试 ============

describe('buildMergedSenderList', () => {
	it('merges blocked and muted lists', () => {
		const result = buildMergedSenderList(['a@b.com', 'c@d.com'], ['e@f.com']);
		expect(result.length).toBe(3);
		expect(result.find(s => s.addr === 'a@b.com')).toEqual({ addr: 'a@b.com', blocked: true, muted: false });
		expect(result.find(s => s.addr === 'e@f.com')).toEqual({ addr: 'e@f.com', blocked: false, muted: true });
	});
	it('marks dual-status addresses', () => {
		const result = buildMergedSenderList(['both@x.com'], ['both@x.com']);
		expect(result.length).toBe(1);
		expect(result[0]).toEqual({ addr: 'both@x.com', blocked: true, muted: true });
	});
	it('sorts alphabetically', () => {
		const result = buildMergedSenderList(['z@z.com', 'a@a.com'], ['m@m.com']);
		expect(result.map(s => s.addr)).toEqual(['a@a.com', 'm@m.com', 'z@z.com']);
	});
	it('returns empty for empty lists', () => {
		expect(buildMergedSenderList([], [])).toEqual([]);
	});
});

describe('buildMgmtText', () => {
	it('shows empty message when no senders', () => {
		const text = buildMgmtText([], 0, null);
		expect(text).toContain('邮箱管理');
		expect(text).toContain('没有屏蔽或静音的发件人');
	});
	it('shows sender list with icons', () => {
		const senders = [
			{ addr: 'spam@evil.com', blocked: true, muted: false },
			{ addr: 'news@site.com', blocked: false, muted: true },
			{ addr: 'both@x.com', blocked: true, muted: true },
		];
		const text = buildMgmtText(senders, 0, null);
		expect(text).toContain('⛔');
		expect(text).toContain('🔇');
		expect(text).toContain('spam@evil.com');
		expect(text).toContain('3 个');
	});
	it('shows storage info', () => {
		const si = { used: 50 * 1024 * 1024, total: 300 * 1024 * 1024 };
		const text = buildMgmtText([], 0, si);
		expect(text).toContain('💾');
		expect(text).toContain('50.0MB');
	});
	it('shows confirm text for att', () => {
		const text = buildMgmtText([], 0, null, 'att');
		expect(text).toContain('确认要清理');
	});
	it('shows confirm text for clrb', () => {
		const text = buildMgmtText([], 0, null, 'clrb');
		expect(text).toContain('确认要清空');
	});
	it('shows search header when keyword provided', () => {
		const senders = [{ addr: 'spam@evil.com', blocked: true, muted: false }];
		const text = buildMgmtText(senders, 0, null, null, 'spam');
		expect(text).toContain('🔍');
		expect(text).toContain('spam');
		expect(text).toContain('匹配 1 个');
	});
	it('shows no match message for empty search', () => {
		const text = buildMgmtText([], 0, null, null, 'xyz');
		expect(text).toContain('没有匹配的地址');
	});
	it('shows page info for multi-page', () => {
		const senders = Array.from({ length: 15 }, (_, i) => ({ addr: `user${i}@test.com`, blocked: true, muted: false }));
		const text = buildMgmtText(senders, 1, null);
		expect(text).toContain('15 个');
		expect(text).toContain('第 2/');
	});
});

describe('buildMgmtKeyboard', () => {
	it('shows remove buttons for each sender', () => {
		const senders = [
			{ addr: 'a@b.com', blocked: true, muted: false },
			{ addr: 'c@d.com', blocked: false, muted: true },
		];
		const kb = buildMgmtKeyboard(senders, 0);
		expect(kb.inline_keyboard[0][0].callback_data).toBe('emr:a@b.com');
		expect(kb.inline_keyboard[0][0].text).toContain('❌');
		expect(kb.inline_keyboard[0][0].text).toContain('⛔');
		expect(kb.inline_keyboard[1][0].text).toContain('🔇');
	});
	it('shows cleanup and action buttons', () => {
		const senders = [{ addr: 'spam@x.com', blocked: true, muted: false }];
		const kb = buildMgmtKeyboard(senders, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('emca');
		expect(allData).toContain('emcd');
		expect(allData).toContain('emcb');
		expect(allData).toContain('ems');
		expect(allData).toContain('back');
	});
	it('hides clear blocked button when no blocked senders', () => {
		const senders = [{ addr: 'news@x.com', blocked: false, muted: true }];
		const kb = buildMgmtKeyboard(senders, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).not.toContain('emcb');
		expect(allData).toContain('ems');
	});
	it('shows confirm cleanup att buttons', () => {
		const kb = buildMgmtKeyboard([], 0, 'att');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('emcca');
		expect(allData).toContain('em');
		expect(allData).not.toContain('emca');
	});
	it('shows confirm cleanup all buttons', () => {
		const kb = buildMgmtKeyboard([], 0, 'all');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('emccd');
		expect(allData).toContain('em');
	});
	it('shows confirm clear blocked buttons', () => {
		const kb = buildMgmtKeyboard([], 0, 'clrb');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('emccb');
		expect(allData).toContain('em');
	});
	it('paginates correctly', () => {
		const senders = Array.from({ length: 15 }, (_, i) => ({ addr: `u${i}@t.com`, blocked: true, muted: false }));
		const kb0 = buildMgmtKeyboard(senders, 0);
		const data0 = kb0.inline_keyboard.flat().map(b => b.callback_data);
		expect(data0).toContain('emp:1');
		expect(data0).not.toContain('emp:-1');
		const kb1 = buildMgmtKeyboard(senders, 1);
		const data1 = kb1.inline_keyboard.flat().map(b => b.callback_data);
		expect(data1).toContain('emp:0');
		expect(data1).toContain('emp:2');
	});
	it('uses emsp prefix for search pagination', () => {
		const senders = Array.from({ length: 15 }, (_, i) => ({ addr: `u${i}@t.com`, blocked: true, muted: false }));
		const kb = buildMgmtKeyboard(senders, 0, null, 'test');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('emsp:1');
		expect(allData).not.toContain('emp:1');
		expect(allData).toContain('em');
		expect(allData).not.toContain('back');
	});
	it('shows back to management button in search mode', () => {
		const senders = [{ addr: 'a@b.com', blocked: true, muted: false }];
		const kb = buildMgmtKeyboard(senders, 0, null, 'search');
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('em');
		expect(allData).not.toContain('emca');
		expect(allData).not.toContain('back');
	});
	it('truncates long addresses in callback_data', () => {
		const longAddr = 'a'.repeat(70) + '@example.com';
		const senders = [{ addr: longAddr, blocked: true, muted: false }];
		const kb = buildMgmtKeyboard(senders, 0);
		const cbData = kb.inline_keyboard[0][0].callback_data;
		expect(new TextEncoder().encode(cbData).length).toBeLessThanOrEqual(64);
		expect(kb.inline_keyboard[0][0].text).toContain(longAddr);
	});
	it('hides search button when no senders', () => {
		const kb = buildMgmtKeyboard([], 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).not.toContain('ems');
		expect(allData).toContain('emca');
	});
});

// ============ 回收站 UI 测试 ============

describe('buildTrashListText', () => {
	it('shows empty message', () => {
		expect(buildTrashListText([], 0)).toBe('🗑 回收站为空');
	});
	it('shows count', () => {
		const list = [{ name: 'a', deletedAt: Date.now() }];
		expect(buildTrashListText(list, 0)).toContain('1 条');
	});
	it('shows page info for multi-page', () => {
		const list = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, deletedAt: Date.now() }));
		expect(buildTrashListText(list, 1)).toContain('第 2/');
	});
});

describe('buildTrashListKeyboard', () => {
	it('shows remaining days for each item', () => {
		const deletedAt = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
		const list = [{ name: 'test', deletedAt }];
		const kb = buildTrashListKeyboard(list, 0);
		expect(kb.inline_keyboard[0][0].text).toContain('20天');
		expect(kb.inline_keyboard[0][0].callback_data).toBe(`ptv:${deletedAt}`);
	});
	it('shows clear all button when has items', () => {
		const list = [{ name: 'test', deletedAt: Date.now() }];
		const kb = buildTrashListKeyboard(list, 0);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptca')).toBe(true);
	});
	it('shows confirm clear all buttons', () => {
		const list = [{ name: 'test', deletedAt: Date.now() }];
		const kb = buildTrashListKeyboard(list, 0, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptcca')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ptl')).toBe(true);
	});
	it('shows back to pwd list button', () => {
		const kb = buildTrashListKeyboard([], 0);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'pb')).toBe(true);
	});
	it('paginates correctly', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, deletedAt: Date.now() }));
		const kb = buildTrashListKeyboard(list, 1);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptp:0')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ptp:2')).toBe(true);
	});
});

describe('buildTrashDetailText', () => {
	it('shows name and remaining days', () => {
		const deletedAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
		const entry = { username: 'user', password: 'pass', note: 'note' };
		const text = buildTrashDetailText('test', entry, deletedAt);
		expect(text).toContain('test');
		expect(text).toContain('25 天');
		expect(text).toContain('user');
		expect(text).toContain('••••••••••');
		expect(text).not.toContain('pass');
		expect(text).toContain('note');
	});
	it('omits empty fields', () => {
		const entry = { username: '', password: '', note: '' };
		const text = buildTrashDetailText('test', entry, Date.now());
		expect(text).not.toContain('👤');
		expect(text).not.toContain('🔑');
		expect(text).not.toContain('📝');
	});
});

describe('buildTrashDetailKeyboard', () => {
	it('shows restore and delete buttons normally', () => {
		const kb = buildTrashDetailKeyboard(12345, false);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptr:12345')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ptd:12345')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ptl')).toBe(true);
	});
	it('shows confirm delete buttons in confirm mode', () => {
		const kb = buildTrashDetailKeyboard(12345, true);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptcd:12345')).toBe(true);
		expect(btns.some(b => b.callback_data === 'ptv:12345')).toBe(true);
	});
});

describe('buildPwdListKeyboard with trash', () => {
	it('shows trash button on last page when trashCount > 0', () => {
		const list = [{ name: 'test', ts: 1 }];
		const kb = buildPwdListKeyboard(list, 0, 3);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptl' && b.text.includes('3'))).toBe(true);
	});
	it('hides trash button when trashCount is 0', () => {
		const list = [{ name: 'test', ts: 1 }];
		const kb = buildPwdListKeyboard(list, 0, 0);
		const btns = kb.inline_keyboard.flat();
		expect(btns.some(b => b.callback_data === 'ptl')).toBe(false);
	});
	it('only shows trash button on last page of multi-page', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, ts: i }));
		const kb0 = buildPwdListKeyboard(list, 0, 2);
		const kb2 = buildPwdListKeyboard(list, 2, 2);
		expect(kb0.inline_keyboard.flat().some(b => b.callback_data === 'ptl')).toBe(false);
		expect(kb2.inline_keyboard.flat().some(b => b.callback_data === 'ptl')).toBe(true);
	});
});
