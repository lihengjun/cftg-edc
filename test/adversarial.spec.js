/**
 * 对抗性测试 — 极端输入和边界条件
 * 模拟一个极度变态的用户，穷举各种奇怪操作
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	esc, classifyAttachment, buildAttachmentSummary, buildNotificationText,
	buildCompactNotificationText,
	TG_MESSAGE_LIMIT, BODY_MAX_LENGTH, ATTACHMENT_MAX_SIZE, TRACKING_PIXEL_MAX_SIZE,
	checkEmailRate, RATE_WINDOW,
	getMaxStorage, getStarMaxStorage, getEmlTtl, getMaxEmailEntries,
	getRateThreshold, getMaxPasswords,
	getRateWindow, getAttachMaxSize, getBodyMaxLength, getTrackingPixelSize,
	CONFIG_ITEMS, getEffectiveValue, loadSystemConfig, setSystemConfig,
	buildConfigText, buildConfigKeyboard, buildMailConfigText,
	buildListText, buildListKeyboard,
	buildSettingsText, buildSettingsKeyboard,
	buildEmailActionKeyboard,
	buildStarredListText,
	buildMergedSenderList, buildMgmtText, buildMgmtKeyboard,
	buildPwdListText, buildPwdListKeyboard, buildPwdDetailText, buildPwdDetailKeyboard,
	buildPwdEditKeyboard, cbData,
	buildSearchText, buildSearchKeyboard, searchEntries,
	isAllowedRecipient, htmlToText,
	calcStorageUsage, cleanExpiredEntries,
	getImageTtl,
	setLang, t,
} from '../src';

beforeEach(() => setLang('zh'));

// ============ BUG #1: view_star / search_view 没有 TG 二次截断 ============

describe('BUG: view_star/search_view 风格的截断缺少 TG 限制保护', () => {
	it('当正文全是 & 符号时，esc 后会膨胀 5 倍，溢出 TG 4096 限制', () => {
		// 模拟 view_star 中的截断逻辑（没有二次截断）
		const bodyMaxLen = BODY_MAX_LENGTH; // 1500
		let body = '&'.repeat(2000);
		if (body.length > bodyMaxLen) body = body.substring(0, bodyMaxLen) + '\n...(已截断)';
		// body 现在是 1500 个 & + 截断后缀
		const escaped = esc(body);
		// 每个 & 变成 &amp; (5 chars)，1500*5=7500
		expect(escaped.length).toBeGreaterThan(7000);
		const header = `📖 <b>收藏邮件</b>\n\n<b>发件人：</b>test@test.com\n<b>主题：</b>test\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
		const total = header.length + escaped.length;
		// 确认超出 TG 限制 — 这就是 bug！
		expect(total).toBeGreaterThan(TG_MESSAGE_LIMIT);
	});

	it('bodyMaxLength=3500 时情况更严重', () => {
		const bodyMaxLen = 3500;
		let body = '&'.repeat(4000);
		if (body.length > bodyMaxLen) body = body.substring(0, bodyMaxLen) + '\n...(已截断)';
		const escaped = esc(body);
		// 3500*5 = 17500 chars
		expect(escaped.length).toBeGreaterThan(17000);
		const header = `📖 <b>邮件详情</b>\n\n<b>发件人：</b>test\n<b>主题：</b>test\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
		const total = header.length + escaped.length;
		expect(total).toBeGreaterThan(TG_MESSAGE_LIMIT * 4); // 远超 4 倍！
	});

	it('buildNotificationText 有保护，不会超过 TG 限制', () => {
		const body = '&'.repeat(2000);
		const parsed = { from: { address: 'a@b.com' }, to: [{ address: 'c@d.com' }], subject: 'test' };
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '');
		// buildNotificationText 有二次截断，应该不超过 TG 限制
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});

	it('buildNotificationText + bodyMaxLen=3500 也有保护', () => {
		const body = '&'.repeat(5000);
		const parsed = { from: { address: 'a@b.com' }, to: [{ address: 'c@d.com' }], subject: 'test' };
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', 3500);
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});
});

// ============ 新增 getter 极端值测试 ============

describe('getter 函数极端值', () => {
	it('KV 配置为 0 时 getRateWindow 返回 0ms（窗口无效）', () => {
		const env = { _sysConfig: { rateWindowMin: 0 } };
		// 0 虽不在 UI 范围内（min=1），但 getConfigValue 不做范围校验
		expect(getRateWindow(env)).toBe(0);
	});

	it('KV 配置为负数时 getAttachMaxSize 返回负数', () => {
		const env = { _sysConfig: { attachMaxSizeMB: -5 } };
		expect(getAttachMaxSize(env)).toBe(-5 * 1024 * 1024);
	});

	it('KV 配置为 0 时 getBodyMaxLength 返回 0，但 buildNotificationText 兜底到 BODY_MAX_LENGTH', () => {
		const env = { _sysConfig: { bodyMaxLength: 0 } };
		expect(getBodyMaxLength(env)).toBe(0);
		// buildNotificationText 中 bodyMaxLen = 0 || BODY_MAX_LENGTH = 1500
		const parsed = { from: { address: 'a@b.com' }, to: [{ address: 'c@d.com' }], subject: 'test' };
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', 'hello', '', 0);
		expect(text).toContain('hello'); // 正文没被截断
	});

	it('KV 配置为极大值时 getTrackingPixelSize 返回极大值', () => {
		const env = { _sysConfig: { trackingPixelKB: 99999 } };
		expect(getTrackingPixelSize(env)).toBe(99999 * 1024);
	});

	it('env 变量为负数时 getter 返回默认值（safeParseInt 拦截负数）', () => {
		expect(getRateWindow({ RATE_WINDOW_MIN: '-5' })).toBe(5 * 60000);
		expect(getAttachMaxSize({ ATTACH_MAX_SIZE_MB: '-1' })).toBe(5 * 1024 * 1024);
		expect(getBodyMaxLength({ BODY_MAX_LEN: '-100' })).toBe(1500);
		expect(getTrackingPixelSize({ TRACKING_PIXEL_KB: '-3' })).toBe(2 * 1024);
	});

	it('env 变量为 0 时 getter 的行为', () => {
		// parseInt('0') = 0, 0 > 0 是 false，fallback 到默认
		expect(getRateWindow({ RATE_WINDOW_MIN: '0' })).toBe(5 * 60000);
		expect(getAttachMaxSize({ ATTACH_MAX_SIZE_MB: '0' })).toBe(5 * 1024 * 1024);
		// 注意：parseInt('0') || 1500 = 0 || 1500 = 1500
		expect(getBodyMaxLength({ BODY_MAX_LEN: '0' })).toBe(1500);
		expect(getTrackingPixelSize({ TRACKING_PIXEL_KB: '0' })).toBe(2 * 1024);
	});

	it('env 变量为非数字时 getter 使用默认值', () => {
		expect(getRateWindow({ RATE_WINDOW_MIN: 'abc' })).toBe(5 * 60000);
		expect(getAttachMaxSize({ ATTACH_MAX_SIZE_MB: '🔥' })).toBe(5 * 1024 * 1024);
		expect(getBodyMaxLength({ BODY_MAX_LEN: 'null' })).toBe(1500);
		expect(getTrackingPixelSize({ TRACKING_PIXEL_KB: '' })).toBe(2 * 1024);
	});

	it('_sysConfig 优先于 env 变量', () => {
		const env = { _sysConfig: { rateWindowMin: 10 }, RATE_WINDOW_MIN: '20' };
		expect(getRateWindow(env)).toBe(10 * 60000);
	});

	it('_sysConfig 为空对象时 fallback 到 env 变量', () => {
		const env = { _sysConfig: {}, RATE_WINDOW_MIN: '15' };
		expect(getRateWindow(env)).toBe(15 * 60000);
	});
});

// ============ checkEmailRate 动态窗口极端测试 ============

describe('checkEmailRate 动态窗口', () => {
	it('窗口为 1 分钟时 TTL 至少 60 秒', async () => {
		let putArgs;
		const mockKV = {
			get: async () => null,
			put: async (k, v, opts) => { putArgs = opts; },
		};
		const env = { KV: mockKV, _sysConfig: { rateWindowMin: 1 } };
		await checkEmailRate(env);
		// TTL = Math.max(Math.ceil(60000/500), 60) = Math.max(120, 60) = 120
		expect(putArgs.expirationTtl).toBe(120);
	});

	it('窗口为 30 分钟时 TTL = 3600 秒', async () => {
		let putArgs;
		const mockKV = {
			get: async () => null,
			put: async (k, v, opts) => { putArgs = opts; },
		};
		const env = { KV: mockKV, _sysConfig: { rateWindowMin: 30 } };
		await checkEmailRate(env);
		// TTL = Math.max(Math.ceil(1800000/500), 60) = 3600
		expect(putArgs.expirationTtl).toBe(3600);
	});

	it('自定义窗口正确过滤时间戳', async () => {
		const now = Date.now();
		// 2分钟前的时间戳，在默认5分钟窗口内，但在自定义1分钟窗口外
		const timestamps = [now - 90000]; // 1.5分钟前
		let savedTimestamps;
		const mockKV = {
			get: async () => JSON.stringify(timestamps),
			put: async (k, v) => { savedTimestamps = JSON.parse(v); },
		};
		const env = { KV: mockKV, _sysConfig: { rateWindowMin: 1 } };
		await checkEmailRate(env);
		// 1分钟窗口应过滤掉1.5分钟前的时间戳
		expect(savedTimestamps.length).toBe(1); // 只有当前新增的
	});

	it('自定义阈值+窗口组合', async () => {
		const now = Date.now();
		// 3个近期时间戳
		const timestamps = [now - 10000, now - 20000, now - 30000];
		const mockKV = {
			get: async () => JSON.stringify(timestamps),
			put: async () => {},
		};
		// 阈值=2, 窗口=1分钟 → 3+1=4 > 2 → 高频
		const env = { KV: mockKV, _sysConfig: { rateThreshold: 2, rateWindowMin: 1 } };
		const result = await checkEmailRate(env);
		expect(result).toBe(true);
	});
});

// ============ classifyAttachment 自定义 trackingSize 测试 ============

describe('classifyAttachment 自定义 trackingSize', () => {
	it('trackingSize=0 时禁用追踪像素过滤（使用 ?? 而非 ||）', () => {
		const att = { mimeType: 'image/png', disposition: 'inline', content: 'ab', related: false };
		// trackingSize = 0 ?? TRACKING_PIXEL_MAX_SIZE = 0
		// size(1) < 0 为 false，不再被忽略
		const result = classifyAttachment(att, 5 * 1024 * 1024, 0);
		expect(result.action).toBe('sendPhoto');
	});

	it('trackingSize=50KB 时较大的 inline 图片也被当作追踪像素', () => {
		const content = 'A'.repeat(40000); // ~30KB
		const att = { mimeType: 'image/png', disposition: 'inline', content, related: false };
		const result = classifyAttachment(att, 5 * 1024 * 1024, 50 * 1024);
		expect(result.action).toBe('ignore'); // 30KB < 50KB → 被错误忽略
	});

	it('不传 trackingSize 时使用默认 TRACKING_PIXEL_MAX_SIZE', () => {
		const att = { mimeType: 'image/png', disposition: 'inline', content: 'ab', related: false };
		const r1 = classifyAttachment(att, 5 * 1024 * 1024);
		const r2 = classifyAttachment(att, 5 * 1024 * 1024, TRACKING_PIXEL_MAX_SIZE);
		expect(r1.action).toBe(r2.action);
	});

	it('trackingSize 为 undefined 时也使用默认值', () => {
		const att = { mimeType: 'image/png', disposition: 'inline', content: 'ab', related: false };
		const r1 = classifyAttachment(att, 5 * 1024 * 1024, undefined);
		expect(r1.action).toBe('ignore');
	});

	it('trackingSize 为 null 时使用默认值（null || default）', () => {
		const att = { mimeType: 'image/png', disposition: 'inline', content: 'ab', related: false };
		const r1 = classifyAttachment(att, 5 * 1024 * 1024, null);
		expect(r1.action).toBe('ignore');
	});
});

// ============ buildNotificationText bodyMaxLen 边界测试 ============

describe('buildNotificationText bodyMaxLen 极端值', () => {
	const parsed = { from: { address: 'a@b.com' }, to: [{ address: 'c@d.com' }], subject: 'test' };

	it('bodyMaxLen=200 时正文被严格截断', () => {
		const body = 'x'.repeat(500);
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', 200);
		// 正文应被截断到 200 字符+截断后缀
		expect(text).toContain('已截断');
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});

	it('bodyMaxLen=3500 时仍然不超过 TG 限制', () => {
		const body = 'normal text '.repeat(500);
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', 3500);
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});

	it('bodyMaxLen=3500 + 全部特殊字符仍然不超过 TG 限制', () => {
		const body = '<>&'.repeat(2000);
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', 3500);
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});

	it('bodyMaxLen=NaN 时 fallback 到默认', () => {
		const body = 'x'.repeat(2000);
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', NaN);
		// NaN || BODY_MAX_LENGTH = 1500
		expect(text).toContain('已截断');
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});

	it('bodyMaxLen=Infinity 时正文不做第一次截断但二次截断仍工作', () => {
		const body = 'x'.repeat(10000);
		const text = buildNotificationText(parsed, 'a@b.com', 'c@d.com', body, '', Infinity);
		// Infinity 是 truthy，所以 Infinity || 1500 = Infinity
		// body.length(10000) > Infinity → false → 不做第一次截断
		// 但二次截断会生效（body > TG limit）
		expect(text.length).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
	});
});

// ============ getConfigValue 无范围校验（KV 被手动篡改） ============

describe('getConfigValue 不做范围校验', () => {
	it('KV 存储超出 max 的值，getEffectiveValue 原样返回', () => {
		const env = { _sysConfig: { bodyMaxLength: 99999 } };
		expect(getEffectiveValue(env, 'bodyMaxLength')).toBe(99999);
		expect(getBodyMaxLength(env)).toBe(99999);
	});

	it('KV 存储低于 min 的值，getEffectiveValue 原样返回', () => {
		const env = { _sysConfig: { bodyMaxLength: 1 } };
		expect(getEffectiveValue(env, 'bodyMaxLength')).toBe(1);
	});

	it('KV 存储负数，getEffectiveValue 原样返回', () => {
		const env = { _sysConfig: { attachMaxSizeMB: -10 } };
		expect(getEffectiveValue(env, 'attachMaxSizeMB')).toBe(-10);
		expect(getAttachMaxSize(env)).toBe(-10 * 1024 * 1024);
	});

	it('KV 存储字符串类型，getEffectiveValue 原样返回（类型不安全）', () => {
		const env = { _sysConfig: { bodyMaxLength: 'not_a_number' } };
		expect(getEffectiveValue(env, 'bodyMaxLength')).toBe('not_a_number');
	});

	it('KV 存储 null，fallback 到 env/default', () => {
		const env = { _sysConfig: { bodyMaxLength: null } };
		// null !== undefined → 返回 null
		expect(getEffectiveValue(env, 'bodyMaxLength')).toBe(null);
	});
});

// ============ buildConfigKeyboard 布局验证 ============

describe('buildConfigKeyboard 主页布局', () => {
	it('键盘布局匹配预期', () => {
		const kb = buildConfigKeyboard();
		const rows = kb.inline_keyboard;
		expect(rows.length).toBe(3); // mail+pwd, lang, back

		expect(rows[0][0].callback_data).toBe('cfg_mail');
		expect(rows[0][1].callback_data).toBe('cfg_pwd');
		expect(rows[1][0].callback_data).toBe('cfg_lang');
		expect(rows[2][0].callback_data).toBe('back');
	});
});

// ============ buildConfigText 新配置项显示 ============

describe('buildMailConfigText 邮件配置项显示', () => {
	it('rateThreshold 单位显示为 "封" 而非 "封/5分钟"', () => {
		const env = { _sysConfig: {} };
		const text = buildMailConfigText(env, null);
		expect(text).toContain('10 封');
		expect(text).not.toContain('封/5分钟');
	});

	it('修改后的值正确显示', () => {
		const env = { _sysConfig: { rateWindowMin: 10, bodyMaxLength: 2000, trackingPixelKB: 5 } };
		const text = buildMailConfigText(env, null);
		expect(text).toContain('10 分钟');
		expect(text).toContain('2000 字符');
		expect(text).toContain('5 KB');
	});

	it('所有 9 项邮件配置都出现在文本中', () => {
		const env = { _sysConfig: {} };
		const text = buildMailConfigText(env, null);
		for (const item of CONFIG_ITEMS) {
			if (item.key === 'maxPasswords') continue;
			expect(text).toContain(t(item.label));
		}
	});

	it('不包含密码条数上限', () => {
		const env = { _sysConfig: {} };
		const text = buildMailConfigText(env, null);
		expect(text).not.toContain('密码条数上限');
	});
});

// ============ 密码模块对抗性测试 ============

describe('密码模块边界条件', () => {
	it('cbData 处理超长名称截断', () => {
		const longName = '中'.repeat(100); // 每个中文 3 字节
		const result = cbData('pv:', longName);
		const enc = new TextEncoder();
		expect(enc.encode(result).length).toBeLessThanOrEqual(64);
	});

	it('cbData 处理空名称', () => {
		const result = cbData('pv:', '');
		expect(result).toBe('pv:');
	});

	it('cbData 处理包含冒号的名称', () => {
		// 虽然 UI 禁止冒号，但 cbData 本身应该能处理
		const result = cbData('pv:', 'a:b:c');
		expect(result).toBe('pv:a:b:c');
	});

	it('buildPwdDetailText 处理所有字段都为空的条目', () => {
		const text = buildPwdDetailText('test', { username: '', password: '', note: '', totp: '' }, false);
		expect(text).toContain('test');
		expect(text).not.toContain('👤'); // 空用户名不显示
		expect(text).not.toContain('🔑'); // 空密码不显示
		expect(text).not.toContain('📝'); // 空备注不显示
	});

	it('buildPwdDetailText 处理含 HTML 特殊字符的密码', () => {
		const entry = { username: '<script>alert(1)</script>', password: '&<>', note: '', totp: '' };
		const text = buildPwdDetailText('test', entry, true);
		expect(text).not.toContain('<script>');
		expect(text).toContain('&lt;script&gt;');
		expect(text).toContain('&amp;&lt;&gt;');
	});

	it('buildPwdListKeyboard 空列表仍有新建和回收站按钮', () => {
		const kb = buildPwdListKeyboard([], 0, 0);
		const rows = kb.inline_keyboard;
		expect(rows.length).toBe(1); // action row only
		expect(rows[0][0].text).toContain('新建');
		expect(rows[0][1].text).toContain('回收站');
	});

	it('buildPwdListKeyboard 第一页有新建和回收站，其他页没有', () => {
		const list = Array.from({ length: 20 }, (_, i) => ({ name: `pwd${i}`, ts: i }));
		const kb0 = buildPwdListKeyboard(list, 0, 0);
		const kb1 = buildPwdListKeyboard(list, 1, 0);
		const allBtns0 = kb0.inline_keyboard.flat();
		const allBtns1 = kb1.inline_keyboard.flat();
		expect(allBtns0.some(b => b.text.includes('新建'))).toBe(true);
		expect(allBtns0.some(b => b.text.includes('回收站'))).toBe(true);
		expect(allBtns1.some(b => b.text.includes('新建'))).toBe(false);
		expect(allBtns1.some(b => b.text.includes('回收站'))).toBe(false);
	});
});

// ============ 邮箱管理对抗性测试 ============

describe('邮箱管理边界条件', () => {
	it('buildMergedSenderList 处理同一地址同时屏蔽+静音', () => {
		const merged = buildMergedSenderList(['a@b.com', 'c@d.com'], ['a@b.com', 'e@f.com']);
		expect(merged.length).toBe(3);
		const ab = merged.find(s => s.addr === 'a@b.com');
		expect(ab.blocked).toBe(true);
		expect(ab.muted).toBe(true);
	});

	it('buildMergedSenderList 空列表', () => {
		const merged = buildMergedSenderList([], []);
		expect(merged.length).toBe(0);
	});

	it('buildMgmtKeyboard callback_data 不超过 64 字节', () => {
		const longAddr = 'very-long-email-address-that-exceeds-limit@extremely-long-domain.example.com';
		const senders = [{ addr: longAddr, blocked: true, muted: false }];
		const kb = buildMgmtKeyboard(senders, 0, null, null);
		for (const row of kb.inline_keyboard) {
			for (const btn of row) {
				const enc = new TextEncoder();
				expect(enc.encode(btn.callback_data).length).toBeLessThanOrEqual(64);
			}
		}
	});
});

// ============ 邮件列表 UI 边界测试 ============

describe('邮件列表 UI 边界条件', () => {
	it('buildListText 处理超长前缀名', () => {
		const active = ['a'.repeat(100)];
		const text = buildListText(active, [], {}, false, [], null);
		expect(text).toContain('a'.repeat(100));
	});

	it('buildListKeyboard 空列表仍有添加按钮', () => {
		const kb = buildListKeyboard([], [], false, 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('add');
		expect(allData).toContain('random');
	});

	it('buildSettingsKeyboard 确认删除和确认删除域名不同时出现', () => {
		const kb = buildSettingsKeyboard('test', ['example.com'], true, false, null);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('confirm_del:test');
		expect(allData).not.toContain('confirm_rm_domain');
	});

	it('buildEmailActionKeyboard 处理超大 attCount', () => {
		const kb = buildEmailActionKeyboard(12345, false, false, 999, false);
		const text = kb.inline_keyboard[0][0].text;
		expect(text).toContain('999');
	});
});

// ============ isAllowedRecipient 边界测试 ============

describe('isAllowedRecipient 极端输入', () => {
	it('收件人不含 @ 时不崩溃', () => {
		// to.toLowerCase().split('@') → ['nodomain', undefined]
		// prefix = 'nodomain', domain = undefined
		const result = isAllowedRecipient('nodomain', ['nodomain'], [], {});
		expect(result).toBe(true); // prefix matches, no domain restriction
	});

	it('空字符串收件人', () => {
		const result = isAllowedRecipient('', [''], [], {});
		expect(result).toBe(true);
	});

	it('多个 @ 的收件人', () => {
		// 'a@b@c'.split('@') → ['a', 'b', 'c']
		// [prefix, domain] = ['a', 'b'] (destructure takes first two)
		const result = isAllowedRecipient('a@b@c', ['a'], [], { a: ['b'] });
		expect(result).toBe(true);
	});
});

// ============ htmlToText 极端输入 ============

describe('htmlToText 恶意输入', () => {
	it('处理超深嵌套标签', () => {
		const nested = '<div>'.repeat(1000) + 'content' + '</div>'.repeat(1000);
		const result = htmlToText(nested);
		expect(result).toContain('content');
	});

	it('处理未闭合标签', () => {
		const html = '<p>hello<br>world<p>more';
		const result = htmlToText(html);
		expect(result).toContain('hello');
		expect(result).toContain('world');
	});

	it('处理 script 注入', () => {
		const html = '<script>document.write("pwned")</script>safe content';
		const result = htmlToText(html);
		expect(result).not.toContain('pwned');
		expect(result).toContain('safe content');
	});

	it('htmlToText(null/undefined) 返回空字符串', () => {
		expect(htmlToText(null)).toBe('');
		expect(htmlToText(undefined)).toBe('');
	});
});

// ============ 搜索功能边界测试 ============

describe('搜索功能极端场景', () => {
	it('searchEntries 处理空关键词（返回全部）', () => {
		const entries = [
			{ sender: 'a@b.com', subject: 'test' },
			{ sender: 'c@d.com', subject: 'hello' },
		];
		const results = searchEntries(entries, '');
		expect(results.length).toBe(2); // 空关键词匹配所有（includes('')是true）
	});

	it('searchEntries 处理正则特殊字符', () => {
		const entries = [
			{ sender: 'a@b.com', subject: 'test (1)' },
		];
		const results = searchEntries(entries, '(1)');
		expect(results.length).toBe(1); // includes 不是正则，所以特殊字符安全
	});

	it('buildSearchText 处理 0 结果', () => {
		const text = buildSearchText('xyzzy', [], 0);
		expect(text).toContain('没有找到');
	});

	it('buildSearchKeyboard 处理空结果', () => {
		const kb = buildSearchKeyboard([], 0);
		const allData = kb.inline_keyboard.flat().map(b => b.callback_data);
		expect(allData).toContain('back');
	});
});

// ============ cleanExpiredEntries 边界 ============

describe('cleanExpiredEntries 极端场景', () => {
	it('所有条目都已过期时清理全部', () => {
		const now = Date.now();
		const index = {
			entries: [
				{ id: 1, ts: now - 100 * 86400000, starred: false, textSize: 100, images: [] },
				{ id: 2, ts: now - 200 * 86400000, starred: false, textSize: 200, images: [] },
			],
			totalSize: 300,
		};
		const removed = cleanExpiredEntries(index, { _sysConfig: {} });
		expect(removed.length).toBe(2);
		expect(index.entries.length).toBe(0);
	});

	it('收藏条目永不过期', () => {
		const now = Date.now();
		const index = {
			entries: [
				{ id: 1, ts: now - 1000 * 86400000, starred: true, textSize: 100, images: [] },
			],
			totalSize: 100,
		};
		const removed = cleanExpiredEntries(index, { _sysConfig: {} });
		expect(removed.length).toBe(0);
		expect(index.entries.length).toBe(1);
	});

	it('totalSize 不会变成负数', () => {
		const now = Date.now();
		const index = {
			entries: [
				{ id: 1, ts: now - 100 * 86400000, starred: false, textSize: 100, images: [] },
			],
			totalSize: 50, // 比 textSize 小（数据不一致）
		};
		cleanExpiredEntries(index, { _sysConfig: {} });
		expect(index.totalSize).toBeGreaterThanOrEqual(0);
	});
});

// ============ CONFIG_ITEMS 一致性验证 ============

describe('CONFIG_ITEMS 一致性', () => {
	it('所有 envKey 都是唯一的', () => {
		const envKeys = CONFIG_ITEMS.map(c => c.envKey);
		expect(new Set(envKeys).size).toBe(envKeys.length);
	});

	it('所有 label 都是唯一的', () => {
		const labels = CONFIG_ITEMS.map(c => c.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('所有 defaultVal 都在 min-max 范围内', () => {
		for (const item of CONFIG_ITEMS) {
			expect(item.defaultVal).toBeGreaterThanOrEqual(item.min);
			expect(item.defaultVal).toBeLessThanOrEqual(item.max);
		}
	});

	it('每个配置项的 getter 都在 _sysConfig 路径正确工作', () => {
		// 验证每个 getter 的 key 正确映射
		const getterMap = {
			maxStorageMB: [getMaxStorage, 500, 500 * 1024 * 1024],
			starMaxStorageMB: [getStarMaxStorage, 100, 100 * 1024 * 1024],
			emlTtlDays: [getEmlTtl, 30, 30 * 86400],
			maxEmailEntries: [getMaxEmailEntries, 10000, 10000],
			rateThreshold: [getRateThreshold, 20, 20],
			rateWindowMin: [getRateWindow, 10, 10 * 60000],
			attachMaxSizeMB: [getAttachMaxSize, 10, 10 * 1024 * 1024],
			bodyMaxLength: [getBodyMaxLength, 2000, 2000],
			trackingPixelKB: [getTrackingPixelSize, 5, 5 * 1024],
			maxPasswords: [getMaxPasswords, 50, 50],
		};
		for (const [key, [getter, input, expected]] of Object.entries(getterMap)) {
			const env = { _sysConfig: { [key]: input } };
			expect(getter(env)).toBe(expected);
		}
	});
});

// ============ 附件分类与 maxSize 交互 ============

describe('附件 maxSize 设为极端值', () => {
	it('maxSize=0 时所有附件都是 listOnly（超出或跳过）', () => {
		const att = { mimeType: 'image/png', disposition: 'attachment', content: 'AAAA' };
		const result = classifyAttachment(att, 0);
		expect(result.action).toBe('listOnly'); // size > 0 > maxSize(0)
	});

	it('maxSize=Infinity 时没有附件会被标为 listOnly', () => {
		const bigContent = 'A'.repeat(100 * 1024 * 1024); // ~75MB
		const att = { mimeType: 'application/pdf', disposition: 'attachment', content: bigContent };
		const result = classifyAttachment(att, Infinity);
		expect(result.action).toBe('sendDocument');
	});

	it('maxSize 为负数时所有附件都是 listOnly', () => {
		const att = { mimeType: 'image/png', disposition: 'attachment', content: 'AAAA' };
		const result = classifyAttachment(att, -1);
		expect(result.action).toBe('listOnly');
	});
});
