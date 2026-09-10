# 发行版本（Edition）与内网版

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 edition 维度、构建身份与能力开关，或改动内网版
> （`CINDY_EDITION=intranet`）相关逻辑、打包入口与端点来源之前

本文约束**第二个构建期维度**：发行版本（edition）。它与区域（region）**正交**，
两者的分工是本文的核心，读错这一条会直接做出错误的设计。

验证命令按 [`desktop-development.md`](desktop-development.md) 选择；本文只约束怎么改，
不重复命令正文。

## 1. 两个正交维度

构建期有**两个**互相独立的维度，各有各的单点：

| 维度 | 取值 | 回答的问题 | 单点 | 受哪份规则约束 |
|---|---|---|---|---|
| **region**（区域） | `cn` / `global` / `dev` | 面向**哪个市场** | `packages/maker-shared/src/brandIdentity.ts` 的 `CindyRegion` | [`../product-rules/region-and-editions.md`](../product-rules/region-and-editions.md) |
| **edition**（发行版本） | `oss` / `intranet` | 这一版**装了什么能力** | `packages/maker-shared/src/cindyEdition.ts` 的 `CindyEdition` | 本文 |

- region 决定**字段值**：一份身份档案里按区域取不同 appId、userData 目录名、端点清单。
- edition 决定**身份档案与能力集**：`brandIdentityForEdition(edition)` 选档案，
  `editionCapabilities(edition)` 选能力。
- 完整派生链：`brandAppId(region, brandIdentityForEdition(edition))`。

### 1.1 增量适用原则与默认值

- **默认 edition 是 `oss`**，与默认 region 是 `global` 同向：未显式注入时落在
  公开发行版，**绝不**落在 `intranet`。理由与 region 相同——误发错能力集的包
  比让人显式指定更难补救。
- 允许省略 edition 的入口，缺省必须落 `oss`。打包与发布入口保持
  「必须显式指定」的 fail-closed 行为，不得为准入便利而引入默认值。
- 非法 edition 值一律**抛错**，不静默回退。构建期身份宁可直接失败。

## 2. 硬性不变量

### 2.1 不得把 edition 做成第四个 region 值

**这是本文最重要的一条。** `intranet` 不是面向用户的发行区域，把它加进
`CindyRegion` 会产生两个具体后果：

1. [`../product-rules/region-and-editions.md`](../product-rules/region-and-editions.md)
   §2.1 规定「无限定词身份归 global」。第四个区域值在这个不变量下无解——它既不是
   中国大陆版，也不该占用 Global 的无后缀值。
2. `scripts/__tests__/brand-identity-sync.test.mjs` 从 `brandIdentity.ts` 源码里抽取
   区域映射，并断言键集恰为 `['cn', 'dev', 'global']`。加第四个键会直接红灯。

同理，**不要**把 region 语义塞进 edition（例如「intranet 就当 cn 处理」）。两者
是独立维度，混用会让「中国内网部署」这类真实组合无法表达。

`packages/maker-shared/src/__tests__/cindyEdition.test.ts` 同时锁住键集与零碰撞，
改动前后必须跑。

### 2.2 引入 edition 不得改变公开发行版行为

`EDITION_CAPABILITIES.oss` 的每个字段都必须为 `true`，且有测试断言。任何
`oss: false` 都等于在默认构建上删功能，必须是有独立产品裁决的动作，不能
在功能 PR 里顺手改。

`brandIdentityForEdition('oss')` 必须返回 `BRAND_IDENTITY` **本体**（同一对象引用），
不是等值副本——后者会让消费方的 `===` 判断与冻结语义悄悄变化。

### 2.3 内网版身份必须与公开版在系统层零碰撞

内网版（`INTRANET_BRAND_IDENTITY`）与公开版的 appId、可执行文件名、userData
目录名、深链 scheme、DB 文件前缀**全部不得相同**。这是「同机装两份」能被支持的
前提，也是避免公开发行版的自更新覆盖内网版安装的前提。

内网版同时**不认领任何公开版的历史标识符**：`legacySchemes`、
`legacyUserDataDirNames`、`legacyDbFilePrefixes` 及两个 `legacy*ByRegion` 映射
全部为空。理由是 `allUserDataDirNames` 这类按路径识别进程归属的消费方会把
legacy 名纳入认领范围——内网版若认领公开版的历史名，orphan-reaper 等消费点就会
去动公开版的数据。

内网版所有区域键取**同值**：它没有 cn/global 市场分化。同值是有意语义，不是
「还没填完」；不要为了「看起来对称」给它编造区域差异。

### 2.4 内网版不得改更新器名（除非先过 cindy-updater 的门）

`INTRANET_BRAND_IDENTITY.updaterName` 与公开版保持同值（`cindy-updater`），
有测试断言。这不是疏漏：

- [`cindy-updater.md`](cindy-updater.md) 规定任何更新链路改动**必须先与仓库维护者
  确认**，未经确认不得提 PR 或直推。
- 内网版按 D7 关闭自动更新（`autoUpdate: false`），更新器根本不会被调用，
  因此改名对功能无收益、却会实打实碰更新链路。

将来若要做内网自更新，必须**同时**改这里、`updateService` 与更新器产物名，并先过
那道门。`updaterName` 的断言会主动失败，提醒来人别只改一半。

### 2.5 能力开关只表达「是否随本版发行」

- 它**不是**权限、不是用户偏好、不是 feature flag。没有开关 UI，不能运行期改。
- 它**不**用于在同一份代码里切换行为——那既拿不到体积收益，又制造「两种行为都
  活着」的隐性分支。能力关闭时应当**真删除或编译期裁掉**对应模块。
- 不要把「能靠打包器 tree-shake」当成「已经删掉了」。`CURRENT_EDITION_CAPABILITIES`
  是对象查表，能否折叠成字面量取决于打包器对跨模块常量传播的能力；**行为与体积上的
  确定性来自真删除**，开关只负责让判断点统一、可读、可测。

## 3. 能力 → 需求对照

`EDITION_CAPABILITIES` 的字段按**用户可见需求的原文**命名，便于逐条对照。
内网版关闭的项与其理据：

| 能力字段 | 需求 | 内网版 | 理由 |
|---|---|---|---|
| `accountLogin` | 1 账号登录 | 关 | 内网无 Cindy 账号服务；本地模式（`AppSessionMode='local'`）已是既有能力，本版让它成为唯一状态 |
| `vendorSubscriptionLogin` | 1（延伸） | 关 | Claude Pro / Codex / xAI 订阅登录需连公网供应商，与「只留自定义供应商」口径一致 |
| `presetModelProviders` | 2 预设供应商 | 关 | 只保留用户自建的自定义供应商（任意 OpenAI / Anthropic 兼容 base URL） |
| `cloudModelCatalog` | 2（延伸） | 关 | 目录只来自包内，不再从服务端下发 |
| `billing` | 3 用量与计费 | 关 | 无 Cindy 计费服务 |
| `voiceInput` | 4 语音输入 | 关 | ⚠️ 注意：ASR **全部是云服务**，没有本地模型，删除不损失离线能力 |
| `imBots` | 4 IM 机器人 | 关 | 外部聊天平台桥接（Telegram / 飞书 / 微信 / Slack / 企微） |
| `sameAccountDeviceLink` | 5 同账号设备互联 | 关 | device-link 的信任根就是账号令牌，无配对码机制；账号删除后它本身已不可用。**SSH 远程不受影响**（用户显式配置目标，不依赖账号） |
| `publicPluginMarket` | 6 公开插件 | 关 | 只删市场 / 发现 / 发布侧，**本地 `.cindy` 安装与管理全链路保留**，见 §4 |
| `publicSkillHub` | 6 公开技能 | 关 | 远端技能抓取关闭；本地技能目录扫描与管理保留 |
| `thirdPartyChatTools` | 7 飞书 / 微信 / Slack | 关 | 见 `apps/desktop/src/main/maker-host/plugins/builtin-plugins.ts` 的 `BUILTIN_META` |
| `telemetry` | 8 遥测 | 关 | 含 TapDB 与日志上报。**本地日志与其记录边界不变量保留**，见 §4 |
| `bundledToolchain` | 9 内置依赖 | **开** | 内网必须自带：Git / Node / agent CLI / ripgrep 随包分发，运行时不下载 |
| `autoUpdate` | D7 | 关 | 接线前必须先过 [`cindy-updater.md`](cindy-updater.md) 的门，见 §2.4 |

## 4. 关闭能力时不得越界的部分

停止某项能力 ≠ 删掉它周边的全部代码。以下边界在裁剪时必须保留：

- **插件基座**：关闭 `publicPluginMarket` 只允许删市场 / 发现 / 发布侧。插件运行时、
  批准状态 schema、内容指纹格式、manifest 契约、能力 slot、安装布局与已装列表投影
  一律不动——动它们要过 [`plugin-security-and-authoring.md`](plugin-security-and-authoring.md)
  的白名单确认门。
- **本地日志与脱敏**：关闭 `telemetry` 只允许删上报链路。`main/logger.ts` 的行格式与
  续行转义是 [`log-upload-and-redaction.md`](log-upload-and-redaction.md) 的记录边界
  不变量，即使不上报也必须保留；脱敏规则**只增不减**。
- **PI 原生能力**：任何裁剪都不得削弱 Pi 的安装 / 更新 / 扩展加载 / Agent 自助修复，
  见 [`pi-harness.md`](pi-harness.md) 的「Pi 上游 GUI 非退化红线」。
- **数据库历史 migration**：能力停用不构成删除历史 migration 的理由，见
  [`database-and-migrations.md`](database-and-migrations.md)。
- **区域身份**：内网版仍需按 region 派生端点与系统身份，不要在裁剪中把 region
  判断一并去掉。

## 5. 验收方法

新增或修改 edition 相关实现时逐条自查：

1. 新能力字段是否**同时**决定了两个 edition 的取值？（只有一个 edition 有该字段会让
   「忘了决定」表现成 `undefined` → 偶发 false，在核心路径上极难排查。）
2. 是否把 edition 做成了第四个 region 值，或反之？（§2.1 禁止）
3. `EDITION_CAPABILITIES.oss` 是否仍全为 `true`？`brandIdentityForEdition('oss')` 是否
   仍返回本体引用？（§2.2）
4. 新增的内网版标识符是否都与公开版不碰撞？是否误认领了公开版的历史标识符？（§2.3）
5. 是否碰了 `updaterName` 或更新链路？碰了就必须先过 [`cindy-updater.md`](cindy-updater.md) 的门。（§2.4）
6. 关闭某能力时，是否越界删了 §4 列举的保留部分？
7. 判断点是否统一读 `CURRENT_EDITION_CAPABILITIES`，而不是在调用点各自重算 edition？
8. 缺省路径是否落在 `oss`？非法值是否抛错而非静默回退？

## 6. 已知边界与待办

- **能力开关的折叠不是保证**，见 §2.5。当前多数需求按实施方案是真删除，开关只是
  统一判断点。
- **`--edition` 打包入口尚未接线**：`scripts/shared/client-endpoint-build-env.mjs` 的
  `desktopClientBuildEnv` 已注入 `VITE_CINDY_EDITION`，`apps/desktop/forge.config.ts`
  已读取 `CINDY_EDITION`，因此可用环境变量构建；但 `package-desktop.mjs` 的显式
  `--edition` 旗标与产物命名归 Phase 12。
- **实机验证**：内网版安装包的离线可用性验收（断网启动、无外联、内置工具链可用）
  尚未执行，不得据「能打包」推断「已离线可用」。
