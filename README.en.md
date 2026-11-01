# dsh-qq-persona

A personable QQ private-chat bridge for DeepSeek Harness (DSH), via [AstrBot](https://github.com/AstrBotDevs/AstrBot) and [NapCat](https://github.com/NapNeko/NapCatQQ).

The point of this project is *continuity of one character*: stable personality from a self-card you write yourself, per-contact isolated memory, a short recovery card written before compaction, and a sealed private journal that only publishes a constrained mood/energy state. Long conversations are compacted in place with DSH's native `/compact` instead of silently swapping sessions.

**This repository ships no character.** Persona, account IDs, tokens, chat history and memory databases are all yours and stay on your machine.

## Features

- Stable persona across restarts and new sessions, defined by your own `self.card.md`
- Per-contact memory isolation (facts, recent window, recovery cards keyed by `umo`)
- Recovery card before compaction; same DSH session continues afterwards
- Sealed journal: body never crosses into another contact's context, only mood / energy / expression tendency (≈24 h TTL)
- Authorization from transport-layer QQ identity — claiming to be "the master" in chat grants nothing
- Outbound guard for phone numbers, e-mail, URLs, local paths and secrets
- Audit log (`audit.ndjson`)
- Optional, off by default: QZone posting (self-visible), proactive private messages, stickers

> **Note:** This project is for personal use and learning only. It is not a product, and no commercial or hosted service is offered. See [Compliance](#compliance).

---

## Architecture

```text
QQ client  ⇄  NapCat (OneBot)  ⇄  AstrBot  ⇄  dsh-qq-persona  ⇄  DeepSeek Harness
   user          bot QQ login       bridge       HTTP ingress (:3188)     model + memory
```

Tested on **Windows, all services on one machine under one system account**, with everything bound to `127.0.0.1`.

## Quick start

Full setup (DSH, AstrBot, NapCat install, wiring and troubleshooting table) is in the Chinese guide [`安装与使用说明.md`](安装与使用说明.md). Minimal path:

1. Fill `provider` and `model` in `cordis.patch.yml` with real IDs from your DSH install — **no API key, and not the display name**.
2. Copy `examples/*` into `%USERPROFILE%\.dsh\qq-bridge\` (`secrets.json`, `self\self.card.md`, `self\self.json`) and fill in your own `master_uin` and `napcat_http_token`.
3. Install the plugin with `dsh plugin --profile desktop add "link:D:/path/to/dsh-qq-persona"`, then restart DSH.
4. Copy `astrbot_plugin_dsh/` into AstrBot's `data/plugins/`, keep `persona_mode: true`, and connect NapCat's reverse WebSocket to AstrBot.
5. Private-message the bot from your own account. No command prefix needed.

## Privacy and security

- No real QQ numbers, contact lists, API keys, conversations, memory databases, journals or media in this repository.
- The ingress listens on loopback only; secrets and data stay under `~/.dsh`.
- Journals are sealed; only a small, typed state crosses contacts.
- QZone is self-visible, proactive sends and stickers are off, group chat is not enabled.
- Outbound guard runs before the model's text leaves the process.

See [`SECURITY.md`](SECURITY.md) for reporting and [`脱敏说明.md`](脱敏说明.md) for exactly what this repository does and does not contain.

## Development

```bash
npm test        # 64 tests
```

Requires Node.js with `node:sqlite` (22.13+ recommended). Numbers, `example` paths and dummy keys in the tests are guard fixtures, not real data.

## Compliance

**This project is for personal use and learning research only.** It is not a product, and offers no commercial, hosted, or supported service.

- It exists as a personal, self-hosted entry point for learning DSH plugin development, AstrBot bridging, and OneBot.
- Automating a QQ account may violate Tencent's terms of service; any account restriction or ban is the user's own risk. Check the laws and platform rules that apply to you before use.
- Do not use it for commercial operations, bulk accounts, mass marketing, impersonation, harassment, or anything that harms others. The outbound guard is a backstop, not a substitute for your own judgment.
- Run it on your own account and your own machine only; do not deploy it as a public service for others.
- The software is provided "AS IS" under the MIT license, without warranty of any kind. The authors and contributors accept no liability for any direct or indirect loss arising from its use.

## Acknowledgements

This project stands on several excellent open-source projects:

| Project | Role here |
|---|---|
| **[AstrBot](https://github.com/AstrBotDevs/AstrBot)** | QQ / OneBot bot framework. The persona-mode bridge is built on its plugin system, message events, configuration and lifecycle |
| **[NapCat](https://github.com/NapNeko/NapCatQQ)** | OneBot implementation on top of NTQQ. Handles QQ login and message transport, and backs the HTTP status check and QZone features |
| **[CCYellowStar2/astrbot_plugin_dsh](https://github.com/CCYellowStar2/astrbot_plugin_dsh)** | Original AstrBot bridge implementation this fork modifies; upstream MIT notice preserved |
| **DeepSeek Harness (DSH)** | The host this plugin runs under as a bundle, providing sessions, native `/compact`, and the plugin mechanism |

If these projects help you, star them first — most of this repository's capability comes from upstream.

## License

MIT — see [`LICENSE`](LICENSE). The AstrBot bridge is derived from [CCYellowStar2/astrbot_plugin_dsh](https://github.com/CCYellowStar2/astrbot_plugin_dsh); upstream notices are preserved and no upstream auto-update source is configured.