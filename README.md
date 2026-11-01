# dsh-qq-persona

**把 DeepSeek Harness 里的同一个角色接进 QQ 私聊。** 通过 AstrBot 与 NapCat 收发消息，用按联系人隔离的记忆、恢复卡和封存日记维持连续性；性格完全由使用者自己写的 `self.card.md` 决定。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![AstrBot](https://img.shields.io/badge/AstrBot-%E2%89%A54.16-blue)](https://github.com/AstrBotDevs/AstrBot)
[![Tests](https://img.shields.io/badge/tests-64%20passed-brightgreen)](test/)

> **English:** dsh-qq-persona bridges a DeepSeek Harness persona agent to QQ private chats via AstrBot and NapCat. Each contact gets isolated memory and a short recovery card; long sessions are compacted in place with DSH's native `/compact`. Journals are sealed and only publish a constrained mood/energy state. The persona itself is always yours to write — this repository ships no character, account, or conversation data.

> **声明：本项目仅供个人使用与学习研究，不提供任何商业服务或托管服务。** 请勿用于商业运营、批量账号、群发营销、冒充他人或其他违反平台规则的用途。详见 [合规与免责](#合规与免责)。

---

## 这是什么

一个 DSH 插件 + 一个 AstrBot 桥接插件，让本机的 DSH 角色用 QQ 私聊同一个人的身份持续对话：

```text
QQ 客户端  ⇄  NapCat (OneBot)  ⇄  AstrBot  ⇄  dsh-qq-persona  ⇄  DeepSeek Harness
   用户           机器人 QQ 登录        桥接插件         HTTP 入站 (:3188)       模型 + 记忆
```

所有服务默认跑在同一台 Windows 机器、同一个系统账户下，只监听 `127.0.0.1`。

### 核心特性

| 特性 | 说明 |
|---|---|
| **同一角色跨会话连续** | 稳定性格来自你自己的 `self.card.md`；重启或换会话后仍从同一角色继续 |
| **按联系人隔离的记忆** | 事实库 / 近期窗口 / 恢复卡都按 `umo` 分区，一个联系人的经历不会漏进另一个人的上下文 |
| **恢复卡** | 压缩前回答四个问题：未完事项、当前关系、上次聊到、相处方式 |
| **同会话原生压缩** | 达到 `contextMaxTokens` 先写恢复卡，再调用宿主 `/compact`，不悄悄换会话 |
| **封存日记** | 日记正文留在本地封存区；跨到下一次聊天的只有受控的心情、精力、表达倾向（约 24 小时） |
| **传输层身份授权** | 主人身份只看 QQ 号的传输层事实，聊天里自称「主人」不会获得权限 |
| **出站守卫** | 手机号、邮箱、链接、本机路径、密钥等默认拦截，不经模型判断 |
| **审计留痕** | 出站与关键事件写 `audit.ndjson`，便于事后核对 |
| **可选能力（默认关闭）** | QQ 空间发布、主动私聊、表情包发送，需自行开启并配置 |

## 目录结构

```text
dsh-qq-persona/
├── lib/                     DSH 插件核心：入站服务、记忆、连续性、人格守卫
├── astrbot_plugin_dsh/      配套 AstrBot 桥接插件（人格模式）
├── cordis.patch.yml         插件默认配置：先填 provider / model
├── examples/                空白密钥配置、通用人设、短期状态示例
├── templates/               日记与恢复卡提示模板
├── scripts/                 Windows 桌面启动器、记忆维护 CLI、表情包生成
├── test/                    64 项自动测试
├── docs/                    性格与续聊机制说明
├── 安装与使用说明.md         ⭐ 第一次安装从这里开始
└── 脱敏说明.md              隐私边界与本仓库存放内容说明
```

## 快速开始

完整步骤（含 DSH、AstrBot、NapCat 的安装与联调、排障表）见 **[安装与使用说明.md](安装与使用说明.md)**。最小路径：

```powershell
# 1. 填配置：把两个占位符替换成 DSH 里已配置的 ID（不要填 API key，也不要填界面显示名）
#    provider: YOUR_DSH_PROVIDER_ID / model: YOUR_MODEL_ID

# 2. 初始化自己的身份文件与人设
$personaDataRoot = Join-Path $env:USERPROFILE '.dsh\qq-bridge'
New-Item -ItemType Directory -Path (Join-Path $personaDataRoot 'self') -Force | Out-Null
Copy-Item '.\examples\secrets.example.json'  (Join-Path $personaDataRoot 'secrets.json')
Copy-Item '.\examples\self.card.example.md'  (Join-Path $personaDataRoot 'self\self.card.md')
Copy-Item '.\examples\self.example.json'     (Join-Path $personaDataRoot 'self\self.json')

# 3. 以 link: 方式装进 DSH，然后重启 DSH
dsh plugin --profile desktop add "link:D:/path/to/dsh-qq-persona"

# 4. 确认插件已加载（只证明加载成功，不代表模型和 QQ 也通了）
Invoke-RestMethod 'http://127.0.0.1:3188/health'
```

然后把 `astrbot_plugin_dsh/` 整个目录复制到 AstrBot 的 `data/plugins/`，保持 `persona_mode: true`，并让 NapCat 的反向 WebSocket 连到 AstrBot。

用**你自己的主号**给机器人发普通私聊，不需要任何前缀。

## 配置要点

| 位置 | 填什么 |
|---|---|
| `cordis.patch.yml` | `provider` / `model`：DSH 中的实际 ID；`allowUsers` 空表即只允许 `master_uin` |
| `~/.dsh/qq-bridge/secrets.json` | `master_uin`（你自己的 QQ 号）、`napcat_http_token`（你自己设的 NapCat token） |
| `~/.dsh/qq-bridge/self/self.card.md` | 角色的名字、气质、表达习惯、边界——**性格由你设定** |
| `~/.dsh/qq-bridge/self/self.json` | 初始心情、精力、活泼程度 |
| AstrBot 插件配置 | `persona_mode: true`，`allow_users` 与 DSH 侧名单保持一致，`allow_groups: []` |

详细字段见 [安装与使用说明.md](安装与使用说明.md) 与 [docs/continuity-template.md](docs/continuity-template.md)。

## 隐私与安全设计

- **不采集**：仓库不含任何真实 QQ 号、联系人名单、API key、聊天记录、记忆库、日记或媒体文件。
- **本地优先**：入站服务只监听 `127.0.0.1`；密钥与数据都留在本机 `~/.dsh` 下。
- **最小发布**：日记正文不出封存区，跨联系人的只有受控状态字段，没有「任意日记摘要」这种外泄通道。
- **默认保守**：QQ 空间仅自己可见、主动私聊与表情包默认关闭、群聊未开放。
- **出站守卫**：联系方式、链接、本机路径、密钥默认被拦，不依赖模型自觉。

安全问题的报告方式见 [SECURITY.md](SECURITY.md)。

## 已知限制

- 只在 **Windows + 同机同账户** 的布局下验证过；Docker、分机、多账户部署需自行处理网络与共享路径。
- 启动器里有几处固定端口检查（`3188`/`6185`/`6199`/`6099`/`5700`），改端口要同步改脚本。
- 自动整理会额外产生模型请求：保存恢复卡与 `/compact` 各需一次生成，实际成本要用真实用量核对。
- 本仓库未在干净机器上做过端到端 QQ 登录验证；使用者需自行完成软件安装与联调。

## 开发与测试

```bash
npm test        # 64 项自动测试
```

需要支持 `node:sqlite` 的 Node.js（建议 22.13+）。测试里的手机号、`example` 路径和假密钥都是守卫测试夹具，不是真实数据。

AstrBot 桥依赖 AstrBot 运行环境；表情包生成脚本另需 Pillow。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 合规与免责

**本项目仅供个人使用与学习研究。** 它不是产品，不提供商业服务、托管服务或任何形式的支持承诺。

- 本项目仅为个人自托管的助手接入口，用于学习 DSH 插件开发、AstrBot 桥接与 OneBot 协议实践。
- QQ 账号自动化可能违反腾讯的服务条款，账号被限制、封禁的风险由使用者自行承担。使用前请自行确认所在地区的法律法规与平台规则。
- 禁止用于商业运营、批量账号、群发营销、冒充他人、骚扰或任何侵犯他人权益的用途；出站守卫只做兜底，不替代使用者的判断。
- 请只在自己的账号、自己的设备上使用；不要部署成面向他人的公开服务。
- 软件按 MIT 许可「按原样」提供，不附带任何明示或暗示的担保。因使用本项目产生的任何直接或间接损失，作者与贡献者不承担责任。

## 致谢

这个项目建立在几个优秀的开源项目之上，没有它们就不可能存在：

| 项目 | 在此处的作用 |
|---|---|
| **[AstrBot](https://github.com/AstrBotDevs/AstrBot)** | QQ / OneBot 机器人框架。本项目的人格模式桥以它的插件系统为基础，依赖它的消息事件、配置与生周期管理 |
| **[NapCat](https://github.com/NapNeko/NapCatQQ)** | 基于 NTQQ 的 OneBot 协议实现。负责 QQ 登录与消息收发，是整条链路的最下游，也是本项目的 HTTP 状态检查与 QQ 空间功能的依赖 |
| **[CCYellowStar2/astrbot_plugin_dsh](https://github.com/CCYellowStar2/astrbot_plugin_dsh)** | AstrBot 桥接部分的原始实现。本仓库的人格模式副本在其基础上修改，MIT 版权声明已保留 |
| **DeepSeek Harness（DSH）** | 本插件作为它的 bundle 运行，使用其会话、原生 `/compact` 与插件机制 |

如果这些项目对你有帮助，请优先给它们点 star——这个仓库的绝大部分能力来自上游。

## 许可证

MIT，见 [LICENSE](LICENSE)。

AstrBot 桥接部分基于 [CCYellowStar2/astrbot_plugin_dsh](https://github.com/CCYellowStar2/astrbot_plugin_dsh) 修改；DSH 插件部分亦源自 CCYellowStar2 的桥接实现。上游版权声明已完整保留。本仓库不设置上游自动更新源，市场更新不会覆盖本地修改。