# 从零开始部署教程

手把手教你搭建 CFTG-EDC，无需任何 Cloudflare 或 Telegram Bot 开发经验。

**预计耗时：** 约 20 分钟

---

## 目录

1. [前置条件](#1-前置条件)
2. [创建 Telegram Bot](#2-创建-telegram-bot)
3. [获取你的 Chat ID](#3-获取你的-chat-id)
4. [注册 Cloudflare](#4-注册-cloudflare)
5. [拉取项目代码](#5-拉取项目代码)
6. [创建 KV 命名空间](#6-创建-kv-命名空间)
7. [配置 wrangler.jsonc](#7-配置-wranglerjsonc)
8. [设置 Secrets](#8-设置-secrets)
9. [部署 Worker](#9-部署-worker)
10. [初始化 Bot](#10-初始化-bot)
11. [配置邮件路由](#11-配置邮件路由)
12. [验证一切正常](#12-验证一切正常)

---

## 1. 前置条件

你需要准备：

- **一个域名** — 已添加到 Cloudflare（免费计划即可）
- **Node.js** — v18 或更高版本（[下载地址](https://nodejs.org/)）
- **Telegram 账号** — 用于创建和使用 Bot

确认 Node.js 已安装：

```bash
node --version   # 应显示 v18.x 或更高
npm --version
```

---

## 2. 创建 Telegram Bot

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`
3. 按提示操作：
   - 输入 Bot 的**显示名称**（如 `My EDC Bot`）
   - 输入 Bot 的**用户名**，必须以 `bot` 结尾（如 `my_edc_bot`）
4. BotFather 会回复你的 **Bot Token**，格式类似：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

> **保存好这个 Token**，第 8 步要用。

<!-- 📸 截图：BotFather 对话，显示生成的 Token -->

5. （可选）发送 `/setdescription` 给 BotFather 设置 Bot 描述
6. （可选）发送 `/setuserpic` 给 BotFather 设置 Bot 头像

---

## 3. 获取你的 Chat ID

Bot 需要知道把消息发给谁，所以需要你的 Chat ID。

1. 在 Telegram 搜索 **@userinfobot**
2. 点击 Start — 它会立刻回复你的用户信息
3. 记下 **Id** 字段 — 这就是你的 Chat ID（一串数字，如 `123456789`）

> **保存好这个数字**，第 8 步要用。

<!-- 📸 截图：userinfobot 回复的用户信息 -->

**重要：** 同时打开你刚创建的 Bot，点击「Start」发起对话。否则 Bot 无法给你发消息。

---

## 4. 注册 Cloudflare

如果你已经有 Cloudflare 账号且域名已添加，直接跳到第 5 步。

1. 前往 [cloudflare.com](https://www.cloudflare.com/) 注册（免费计划即可）
2. 按引导将你的域名添加到 Cloudflare
3. 到域名注册商处，将 DNS 服务器（Nameservers）改为 Cloudflare 提供的地址
4. 等待域名生效（通常几分钟，最长 24 小时）

<!-- 📸 截图：Cloudflare 控制台显示域名已激活 -->

---

## 5. 拉取项目代码

```bash
git clone https://github.com/lihengjun/cftg-edc.git
cd cftg-edc
npm install
```

这会安装项目和所有依赖（只有 `postal-mime` 一个运行时依赖）。

确认 wrangler CLI 可用：

```bash
npx wrangler --version
```

如果是第一次使用 wrangler，需要登录 Cloudflare 账号：

```bash
npx wrangler login
```

会自动打开浏览器进行授权。

<!-- 📸 截图：终端显示 wrangler 登录成功 -->

---

## 6. 创建 KV 命名空间

KV 是存储所有数据（邮件、密码、配置）的地方。

```bash
npx wrangler kv namespace create KV
```

输出类似：

```
🌀 Creating namespace with title "cftg-edc-KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

> **复制这个 `id` 值**，下一步要用。

---

## 7. 配置 wrangler.jsonc

复制示例配置文件：

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

打开 `wrangler.jsonc`，将 `<your-kv-namespace-id>` 替换为第 6 步得到的 ID：

```jsonc
{
  "name": "cftg-edc",
  "main": "src/index.js",
  "compatibility_date": "2026-02-05",
  "observability": { "enabled": true },
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [
    { "binding": "KV", "id": "在这里粘贴你的-kv-id" }
  ]
}
```

只需要改这一处。下面注释掉的 `vars` 部分是可选配置，默认值适合大多数用户，暂时不用管。

---

## 8. 设置 Secrets

需要配置 3 个密钥。逐个运行以下命令，在提示时粘贴对应的值：

```bash
npx wrangler secret put TG_BOT_TOKEN
# 粘贴第 2 步获得的 Bot Token

npx wrangler secret put TG_CHAT_ID
# 粘贴第 3 步获得的 Chat ID

npx wrangler secret put PWD_KEY
# 粘贴一个随机字符串（用于加密密码）
```

**生成强密钥的方法：**

```bash
openssl rand -base64 32
```

用输出的字符串作为 `PWD_KEY`。这个密钥用于加密所有存储的密码 — **请务必备份保存**。丢失后已加密的密码将无法恢复。

---

## 9. 部署 Worker

```bash
npx wrangler deploy
```

输出类似：

```
Uploaded cftg-edc (x.xx sec)
Deployed cftg-edc triggers (x.xx sec)
  https://cftg-edc.your-subdomain.workers.dev
```

> **记下这个 URL**，这是你的 Worker 地址。

<!-- 📸 截图：终端显示部署成功 -->

---

## 10. 初始化 Bot

在浏览器中打开以下地址（替换为你的实际 Worker URL）：

```
https://cftg-edc.your-subdomain.workers.dev/init
```

页面应显示：

```
Webhook set & commands registered
```

这一步做了两件事：
- 注册 Telegram Webhook，让 Bot 能接收消息
- 设置 Bot 命令菜单（`/list`、`/search`、`/pwd`、`/config`）

现在回到 Telegram，给你的 Bot 发送 `/config`。如果它回复了设置面板，**说明 Bot 已经在工作了！**

<!-- 📸 截图：Telegram 中 /config 命令的设置面板 -->

---

## 11. 配置邮件路由

这一步将你的域名邮箱连接到 Bot。

### 11.1 启用 Email Routing

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 选择你的域名
3. 在左侧菜单点击 **Email** → **Email Routing**
4. 如果尚未启用，点击 **Get started** 按引导完成设置

<!-- 📸 截图：Cloudflare Email Routing 页面 -->

### 11.2 添加 Catch-All 规则

1. 在 Email Routing 页面，进入 **Routing rules** 标签页
2. 找到 **Catch-all address**，点击 Edit
3. 将 Action 设为 **Send to a Worker**
4. 选择你的 `cftg-edc` Worker
5. 保存

<!-- 📸 截图：Catch-all 规则配置，指向 Worker -->

这会将所有发往 `*@yourdomain.com` 的邮件路由到你的 Bot。如果你不想接收所有地址的邮件，也可以只设置特定地址的规则。

### 11.3 添加邮箱前缀

在 Telegram 中给 Bot 发送 `/list`：

1. 点击 **➕ 添加** 按钮
2. 回复一个前缀名（如 `hello`）
3. 现在 `hello@yourdomain.com` 收到的邮件就会转发到你的 Telegram

你可以添加任意多个前缀。只有匹配已注册前缀的邮件才会被转发，其余邮件会被静默丢弃。

<!-- 📸 截图：Telegram 中 /list 的前缀管理界面 -->

---

## 12. 验证一切正常

### 测试邮件转发

从任意邮箱发送一封测试邮件到 `你的前缀@yourdomain.com`。几秒内，你应该在 Telegram 收到通知，包含发件人、主题和正文。

<!-- 📸 截图：Telegram 中收到的邮件转发通知 -->

### 测试密码管理器

给 Bot 发送 `/pwd`，试着创建一条密码：

1. 点击 **➕ 新建**
2. 回复一个名称（如 `GitHub`）
3. 密码条目创建完成 — 可以继续编辑各字段（用户名、密码、备注、TOTP）

<!-- 📸 截图：Telegram 中的密码管理器界面 -->

### 测试系统配置

给 Bot 发送 `/config`，可以看到所有可调整的配置项和当前值。点击任意配置项即可修改。

---

## 搞定！

你的个人 EDC 工具箱已经上线了。快速参考：

| 命令 | 功能 |
|------|------|
| `/list` | 管理邮箱前缀 |
| `/search <关键词>` | 按发件人或主题搜索邮件 |
| `/pwd` | 密码管理器 |
| `/save <名称>` | 快速保存新密码 |
| `/config` | 系统配置 |

---

## 常见问题

### Bot 不回复消息

- 确认你已经和 Bot 发起了对话（在 Telegram 中点过「Start」）
- 确认 `TG_CHAT_ID` 是你本人的 ID，不是 Bot 的 ID
- 重新访问初始化地址：`https://your-worker.workers.dev/init`

### 邮件没有转发

- 检查 Email Routing 是否已启用，Catch-all 规则是否指向你的 Worker
- 确认你已经通过 `/list` 添加了至少一个前缀
- 在 Cloudflare 控制台 → Email → Email Routing → Activity log 查看投递状态

### "Webhook set" 但 Bot 仍不工作

- 查看 Worker 日志：`npx wrangler tail`（实时日志）
- 确认 3 个 Secrets 都已设置：`npx wrangler secret list`

### 密码加密出错

- `PWD_KEY` 必须设置为 Secret，不要写在 `wrangler.jsonc` 的 vars 里
- 如果在保存密码之后更换了 `PWD_KEY`，旧密码将无法解密

---

## 更新版本

拉取最新代码后重新部署即可：

```bash
git pull
npm install
npx wrangler deploy
```

一般不需要重新执行 `/init`，除非更新说明中特别提到。
