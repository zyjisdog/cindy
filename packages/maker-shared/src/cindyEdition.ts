/**
 * cindy-edition — 产品**发行版本(edition)层**的单一事实源(构建期单点)。
 *
 * 与 `brandIdentity.ts`(标识符层:appId / exe 名 / userData 目录 / 深链 scheme)
 * 和 `branding.ts`(展示名层)互补。三者分工:
 *   - `branding.ts`      → 用户 / LLM 看到的名字
 *   - `brandIdentity.ts` → OS 注册身份与磁盘 / 协议标识符
 *   - 本文件             → 这一版**装了什么能力**,以及它配哪套标识符
 *
 * ⚠️ 语义边界(与 brandIdentity.ts 同规矩):
 *  - 这是**构建期单点,不是运行时开关**。经打包命令的 `CINDY_EDITION` 选择,
 *    默认 `oss`。运行时不可切换。
 *  - **edition 与 region 是两个正交维度,不要合并**:
 *    `/region` 回答"面向哪个市场"(cn / global / dev),由 `CindyRegion` 表达,
 *    受 `docs/product-rules/region-and-editions.md` 约束;
 *    `/edition` 回答"这一版装了什么能力"(oss / intranet)。
 *    把 intranet 塞进 `CindyRegion` 是**错的** —— 它不是一个面向用户的发行区域,
 *    会给 `region-and-editions.md` §2.1(无限定词归 global)制造一个无解的第四值,
 *    也会破坏 `scripts/__tests__/brand-identity-sync.test.mjs` 对区域映射键集
 *    (`['cn','dev','global']`)的断言。
 *  - 能力开关的**唯一用途**是让"内网版不装某功能"成为编译期事实,从而可被
 *    打包器 tree-shake 掉。**不要**用它做运行时 if 开关去切换同一份代码的行为,
 *    那既拿不到体积收益,也制造了"两种行为都活着"的隐性分支。
 *  - 开关只表达"该能力是否随本版发行",**不表达权限、不表达用户偏好**。
 *
 * 消费方:
 *  - `packages/maker-shared/src/brandIdentity.ts`(按 edition 选身份)
 *  - `apps/desktop/src/shared/cindyEdition.ts`(运行时烘焙值 + 能力快照)
 *  - `apps/desktop/forge.config.ts` / `scripts/shared/client-endpoint-build-env.mjs`
 *    (构建期注入)
 *  - 后续各阶段的功能裁剪点(见 `docs/dev-rules/intranet-edition.md` 的能力→需求对照)
 */

/**
 * 发行版本。
 *
 * - `oss`      开源 / 公开发行版,即本仓默认产物;**全部能力开启**,行为与引入
 *              edition 维度之前逐字节一致。
 * - `intranet` 内网个人版:不依赖任何 Cindy 线上服务的离线构建。数据只落本机,
 *              模型只走用户自建的自定义供应商,依赖运行时随包内置。
 */
export type CindyEdition = 'oss' | 'intranet';

/** 默认发行版本:开源版。未显式注入 edition 的构建一律落在这里(与 region 默认 global 同风格)。 */
export const DEFAULT_CINDY_EDITION: CindyEdition = 'oss';

/**
 * 归一化 edition 输入(构建脚本 env / 运行时注入值)。空值 → 默认 oss;
 * 非法值抛错——打包链路宁可失败也不能默默打出能力集错误的包。
 */
export function resolveCindyEdition(raw?: string | null): CindyEdition {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_CINDY_EDITION;
  if (v === 'oss' || v === 'intranet') return v;
  throw new Error(`Invalid Cindy edition: ${raw}; expected oss or intranet`);
}

/**
 * 一个 edition 的能力集。字段全部为布尔,全部按**用户可见需求的原文**命名,
 * 便于 review 时逐条对照(映射见 `docs/dev-rules/intranet-edition.md`)。
 *
 * 命名约定:`false` = 该能力**不随本版发行**(代码应被删除或编译期裁掉),
 * `true` = 随本版发行。不要用"是否禁用"这类反向命名,避免双重否定。
 */
export interface EditionCapabilities {
  /** 需求 1:Cindy 账号登录 / 注册 / 账号切换 / 账号注销。 */
  readonly accountLogin: boolean;
  /**
   * D5:供应商 OAuth 订阅账号登录(Claude Pro / Codex / xAI 订阅)。
   * 与 accountLogin 分开:前者是 Cindy 自己的账号,这里是第三方供应商的订阅登录,
   * 两者的凭据存储与失效路径完全不同。
   */
  readonly vendorSubscriptionLogin: boolean;
  /** 需求 2:随客户端分发的预设模型供应商(Cindy AI / OpenAI / Anthropic / xAI / Gemini)与预设目录。 */
  readonly presetModelProviders: boolean;
  /** 需求 2:从服务端下发模型目录(`/api/model-catalog/catalog`)。本版目录只来自包内。 */
  readonly cloudModelCatalog: boolean;
  /** 需求 3:用量与计费页面(账单、额度、套餐、充值)。 */
  readonly billing: boolean;
  /** 需求 4a:语音输入(云端 ASR 与听写润色)。注意:本项开启时不代表离线可用——ASR 全为云服务。 */
  readonly voiceInput: boolean;
  /** 需求 4b:IM 机器人(Telegram / 飞书 / 微信 / Slack / 企微等外部聊天平台桥接)。 */
  readonly imBots: boolean;
  /** 需求 5:同账号设备互联(device-link 中继、在线心跳、同一账号的设备列表与远程控制)。 */
  readonly sameAccountDeviceLink: boolean;
  /** 需求 6a:公开插件市场(浏览 / 安装 / 自定义市场源 / 发布)。 */
  readonly publicPluginMarket: boolean;
  /** 需求 6b:公开技能中心(skillhub 远端技能抓取)。 */
  readonly publicSkillHub: boolean;
  /** 需求 7:飞书 / 微信 / Slack 工具(builtin MCP 插件与连接授权卡)。 */
  readonly thirdPartyChatTools: boolean;
  /** 需求 8:遥测与分析(含 TapDB)与日志上报。 */
  readonly telemetry: boolean;
  /**
   * 需求 9:Git / Node / agent CLI 等运行时依赖随安装包内置,而非运行时下载。
   * 这一项在 oss 版也有意义(`cindy-make` 的托管工具链),故独立成项。
   */
  readonly bundledToolchain: boolean;
  /**
   * D7:自动更新。
   * ⚠️ 关掉它需要改更新链路,而 `docs/dev-rules/cindy-updater.md` 规定任何更新链路
   * 改动**必须先与仓库维护者确认**。本开关只声明意图;实际接线前必须先走那道门。
   */
  readonly autoUpdate: boolean;
}

/**
 * 两版能力对照表。
 *
 * `oss` 全开 —— 这是**刻意**的:引入 edition 维度本身不得改变公开发行版的行为,
 * 任何 `oss: false` 都等于在默认构建上删功能,必须单独有产品裁决。
 */
export const EDITION_CAPABILITIES: Readonly<Record<CindyEdition, EditionCapabilities>> =
  Object.freeze({
    oss: Object.freeze({
      accountLogin: true,
      vendorSubscriptionLogin: true,
      presetModelProviders: true,
      cloudModelCatalog: true,
      billing: true,
      voiceInput: true,
      imBots: true,
      sameAccountDeviceLink: true,
      publicPluginMarket: true,
      publicSkillHub: true,
      thirdPartyChatTools: true,
      telemetry: true,
      bundledToolchain: true,
      autoUpdate: true,
    }),
    intranet: Object.freeze({
      accountLogin: false,
      vendorSubscriptionLogin: false,
      presetModelProviders: false,
      cloudModelCatalog: false,
      billing: false,
      voiceInput: false,
      imBots: false,
      sameAccountDeviceLink: false,
      publicPluginMarket: false,
      publicSkillHub: false,
      thirdPartyChatTools: false,
      telemetry: false,
      bundledToolchain: true,
      autoUpdate: false,
    }),
  });

/** 取某 edition 的能力集;默认 oss。 */
export function editionCapabilities(
  edition: CindyEdition = DEFAULT_CINDY_EDITION,
): EditionCapabilities {
  return EDITION_CAPABILITIES[edition];
}

/**
 * 该 edition 是否持有"离线自足"承诺(不依赖任何 Cindy 线上服务即可完整使用)。
 * 目前等价于"无账号登录" —— 认证是所有云能力的共同前置。做成派生函数而不是常量,
 * 是为了让后续再裁云能力时不必逐个改判断点。
 */
export function isOfflineSelfSufficient(
  edition: CindyEdition = DEFAULT_CINDY_EDITION,
): boolean {
  return !editionCapabilities(edition).accountLogin;
}
