# AstrBot 桥 · dsh-qq-persona 配套插件

这是从上游 `astrbot_plugin_dsh` 修改的人格模式桥，需与本仓库根目录的 DSH 插件一起使用。保留上游插件标识与桥接版本号 `0.3.23`；它不代表上游市场版本具备本仓库的全部行为。

将本目录完整复制到 AstrBot 的 `data/plugins/astrbot_plugin_dsh/`，避免再多套一层同名目录；重启 AstrBot。不要同时启用另一份同名桥或用市场更新覆盖本副本。复制前自行备份已有目录。

在 AstrBot 配置中启用本插件，并设置：

- `enabled: true`
- `persona_mode: true`
- `allow_users`：自行填写获准联系人的 QQ 号，全部用字符串。与 DSH 的 `allowUsers` 保持一致；同机同账户能读到的 `master_uin` 也会被允许。
- `allow_groups: []`
- `ingress_url` 和 `token`：同机、同一系统账户且使用默认 DSH_HOME 时可留空，从 `~/.dsh/astrbot-ingress.json` 自动发现。否则按 DSH 插件生成的地址和 token 手动配置。

人格模式会接管白名单联系人的私聊文本和图片，不需要 `/dsh` 前缀；不开放群聊。名单外私聊会静默忽略。AstrBot 管理员身份不会额外绕过人格模式的名单。上游 coding 模式的过程档位、工作区和文件传输配置，不是本插件的接入步骤。

完整依赖、DSH 安装、NapCat 连接和排障步骤见本包根目录的 `安装与使用说明.md`。

基于 [CCYellowStar2/astrbot_plugin_dsh](https://github.com/CCYellowStar2/astrbot_plugin_dsh) 修改，MIT 版权声明见 `LICENSE`。此链接仅用于说明来源，本插件不设置上游自动更新地址。

运行环境由 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 提供，QQ 收发由 [NapCat](https://github.com/NapNeko/NapCatQQ) 完成。本项目仅供个人使用与学习。
