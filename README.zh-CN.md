中文 | [English](README.md)

# CFTG-EDC

**CloudFlare + TeleGram Every Day Carry** — 运行在 Cloudflare Workers 上的个人工具箱，完全通过 Telegram 管理。

> 零服务器、零成本、零维护。只需你和你的 Telegram Bot。

## 这是什么？

一个 Cloudflare Worker，把你的 Telegram Bot 变成个人指挥中心：

- **邮件转发** — 实时接收邮件通知，支持发件人过滤、附件预览、搜索
- **密码管理器** — AES-256 加密存储，支持 TOTP 两步验证、回收站恢复
- **备份系统** — 每日自动 KV 备份，手动导出/导入支持 3 种加密模式
- **完全可配置** — 10+ 项设置（存储上限、频率阈值等）无需重新部署即可调整

所有操作都在 Telegram 对话中完成。不需要网页界面、不需要安装 App、不需要管理数据库。

## 功能

### 邮件

| 功能 | 说明 |
|------|------|
| 实时通知 | 新邮件即时转发到 Telegram，包含完整头部和正文 |
| 智能过滤 | 基于前缀的规则，每个前缀可独立限制发件域名 |
| 发件人管理 | 屏蔽/静音单个发件人 |
| 附件处理 | 图片预览、.eml 下载、自动淘汰过期存储 |
| 搜索 | 按发件人或主题全文搜索 |
| 收藏邮件 | 标星重要邮件，独立存储配额 |
| 全局静音 | 一键暂停所有通知 |
| 频率限制 | 邮件洪峰时自动切换为精简格式 |

### 密码

| 功能 | 说明 |
|------|------|
| 加密存储 | AES-256-GCM，每个部署独立密钥 |
| TOTP 两步验证 | 生成基于时间的验证码 |
| 自动隐藏 | 密码 30 秒后自动隐藏 |
| 回收站 | 30 天软删除，支持恢复 |
| 导出/导入 | 明文、自动加密（PWD_KEY）、密码加密（PBKDF2）三种模式 |
| 每日备份 | 定时 KV 快照，31 天自动过期 |

### 系统

| 功能 | 说明 |
|------|------|
| 国际化 | 英文（默认）和中文，对话内切换 |
| 10+ 配置项 | 存储上限、保留天数、频率阈值等，全部通过 Telegram 调整 |
| 零成本托管 | 运行在 Cloudflare Workers 免费套餐 |
| 隐私优先 | 数据存储在你自己的 Cloudflare KV，不经过第三方服务 |

## 架构

```
收到邮件
     |
     v
+-----------------+       +------------------+
| Cloudflare      |       | Telegram Bot API |
| Email Routing   |------>| (通知)           |
+-----------------+       +------------------+
     |                           ^
     v                           |
+-----------------+       +------------------+
| Cloudflare      |<----->| Webhook 处理     |
| Worker          |       | (命令、界面)     |
+-----------------+       +------------------+
     |
     v
+-----------------+
| Cloudflare KV   |
| (所有数据)      |
+-----------------+
```

**技术栈：** Cloudflare Workers + KV + Email Routing + Telegram Bot API

**依赖：** 仅 [`postal-mime`](https://github.com/nicknisi/postal-mime) 用于邮件解析，其余全部从零构建。

## 快速上手

完整教程请看 **[从零开始部署教程](docs/setup-guide.md)**。

**简要步骤：**

```bash
git clone https://github.com/lihengjun/cftg-edc.git
cd cftg-edc
npm install
cp wrangler.jsonc.example wrangler.jsonc
# 编辑 wrangler.jsonc：填入你的 KV namespace ID
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put PWD_KEY
npx wrangler deploy
# 访问 https://your-worker.workers.dev/init
```

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/list` | 管理邮箱前缀 |
| `/search <关键词>` | 按发件人或主题搜索邮件 |
| `/pwd` | 密码管理器 |
| `/save <名称>` | 快速保存新密码 |
| `/config` | 系统配置 |

## 截图

<!-- TODO: 添加截图 -->

> 截图即将添加。界面完全由 Telegram 内联键盘构成。

## 配置项

所有设置均可在 Telegram 中通过 `/config` 调整：

| 设置 | 默认值 | 说明 |
|------|--------|------|
| 邮件存储 | 300 MB | 邮件总存储上限 |
| 收藏存储 | 50 MB | 收藏邮件存储上限 |
| 邮件保留 | 60 天 | .eml 文件保留天数 |
| 最大条目 | 5000 | 邮件索引最大条目数 |
| 频率阈值 | 10 | 触发精简模式的邮件数/窗口 |
| 频率窗口 | 5 分钟 | 频率检测时间窗口 |
| 附件限制 | 5 MB | 单个附件最大下载大小 |
| 正文截断 | 1500 字符 | 通知中正文最大长度 |
| 追踪像素 | 2 KB | 自动忽略小于此大小的内嵌图片 |
| 密码上限 | 不限 | 最大密码条数 |

## 开发

```bash
npm install
npm test              # 运行 379 个测试
npx wrangler dev      # 本地开发
npx wrangler deploy   # 部署到生产环境
```

## 技术细节

- **加密：** AES-256-GCM 用于密码存储；PBKDF2（100k 次迭代，SHA-256）用于密码导出加密
- **邮件解析：** postal-mime，自动字符集检测，GB2312/GBK 回退
- **存储：** Cloudflare KV，基于 TTL 过期和 LRU 淘汰
- **备份：** 每日 UTC 02:00 定时任务，KV 条目存储，31 天 TTL
- **测试：** 379 个测试覆盖所有模块，使用 vitest + @cloudflare/vitest-pool-workers

## 许可证

MIT
