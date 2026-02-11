# CFTG-EDC

**CloudFlare + TeleGram Every Day Carry** — a personal toolkit running on Cloudflare Workers, managed entirely through Telegram.

> Zero server. Zero cost. Zero maintenance. Just you and your Telegram bot.

## What is this?

A single Cloudflare Worker that turns your Telegram bot into a personal command center:

- **Email forwarding** — Receive email notifications instantly in Telegram, with sender filtering, attachments, and search
- **Password manager** — Store, edit, and organize passwords with AES-256 encryption, TOTP 2FA, and trash/restore
- **Backup system** — Auto-daily KV backups, manual export/import with 3 encryption modes
- **Fully configurable** — Tune 10+ settings (storage limits, rate thresholds, etc.) without redeploying

All interactions happen inside a single Telegram chat. No web UI. No app to install. No database to manage.

## Features

### Email

| Feature | Description |
|---------|-------------|
| Real-time notifications | New emails forwarded to Telegram with full headers and body |
| Smart filtering | Prefix-based rules with per-prefix domain restrictions |
| Sender management | Block / mute individual senders |
| Attachments | Image preview, .eml download, storage with auto-eviction |
| Search | Full-text search by sender or subject |
| Starred emails | Pin important emails with dedicated storage quota |
| Global mute | Silence all notifications with one tap |
| Rate limiting | Auto-switch to compact format during email floods |

### Password

| Feature | Description |
|---------|-------------|
| Encrypted storage | AES-256-GCM with per-deployment key |
| TOTP 2FA | Generate time-based verification codes |
| Auto-hide | Passwords auto-hidden after 30 seconds |
| Trash & restore | 30-day soft delete with recovery |
| Export / Import | Plain text, auto-encrypted (PWD_KEY), or password-encrypted (PBKDF2) |
| Daily backup | Cron-triggered KV snapshots, 31-day retention |

### System

| Feature | Description |
|---------|-------------|
| i18n | English (default) and Chinese, switchable in-chat |
| 10+ config items | Storage limits, retention days, rate thresholds — all adjustable via Telegram |
| Zero-cost hosting | Runs on Cloudflare Workers free tier |
| Privacy-first | Data stays in your Cloudflare KV; no third-party services |

## Architecture

```
Incoming Email
     |
     v
+-----------------+       +------------------+
| Cloudflare      |       | Telegram Bot API |
| Email Routing   |------>| (notifications)  |
+-----------------+       +------------------+
     |                           ^
     v                           |
+-----------------+       +------------------+
| Cloudflare      |<----->| Webhook handler  |
| Worker          |       | (commands, UI)   |
+-----------------+       +------------------+
     |
     v
+-----------------+
| Cloudflare KV   |
| (all data)      |
+-----------------+
```

**Stack:** Cloudflare Workers + KV + Email Routing + Telegram Bot API

**Dependencies:** Only [`postal-mime`](https://github.com/nicknisi/postal-mime) for email parsing. Everything else is built from scratch.

## Quick Start

See the **[Setup Guide](docs/setup-guide.md)** for a complete step-by-step tutorial.

**TL;DR:**

```bash
git clone https://github.com/lihengjun/cftg-edc.git
cd cftg-edc
npm install
cp wrangler.jsonc.example wrangler.jsonc
# Edit wrangler.jsonc: fill in your KV namespace ID
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put PWD_KEY
npx wrangler deploy
# Visit https://your-worker.workers.dev/init
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/list` | Manage email prefixes |
| `/search <keyword>` | Search emails by sender or subject |
| `/pwd` | Password manager |
| `/save <name>` | Quick-save a new password |
| `/config` | System settings |

## Screenshots

<!-- TODO: Add screenshots -->

> Screenshots coming soon. The UI is entirely inline keyboards inside Telegram.

## Configuration

All settings can be adjusted in Telegram via `/config`:

| Setting | Default | Description |
|---------|---------|-------------|
| Mail Storage | 300 MB | Total email storage limit |
| Star Storage | 50 MB | Starred email storage limit |
| Email Retention | 60 days | How long .eml files are kept |
| Max Entries | 5000 | Maximum email index entries |
| Rate Threshold | 10 | Emails per window before compact mode |
| Rate Window | 5 min | Time window for rate detection |
| Attachment Limit | 5 MB | Max attachment size to download |
| Body Truncation | 1500 chars | Max body length in notifications |
| Tracking Pixel | 2 KB | Auto-ignore inline images below this |
| Password Limit | Unlimited | Maximum number of passwords |

## Development

```bash
npm install
npm test              # Run 379 tests
npx wrangler dev      # Local development
npx wrangler deploy   # Deploy to production
```

## Tech Details

- **Encryption:** AES-256-GCM for password storage; PBKDF2 (100k iterations, SHA-256) for password-based export encryption
- **Email parsing:** postal-mime with automatic charset detection and GB2312/GBK fallback
- **Storage:** Cloudflare KV with TTL-based expiration and LRU eviction
- **Backup:** Daily cron at 02:00 UTC, stored as KV entries with 31-day TTL
- **Tests:** 379 tests covering all modules, using vitest + @cloudflare/vitest-pool-workers

## License

MIT
