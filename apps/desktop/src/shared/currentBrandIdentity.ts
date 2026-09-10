/**
 * currentBrandIdentity — 本构建(region × edition)的**标识符身份单一入口**。
 *
 * 背景:标识符层身份的事实源是 `@cindy/maker-shared/brand-identity`,它的每个取值
 * 函数都接受 `(region, identity)` 两个入参。edition 维度加入后,凡是在桌面侧
 * **派生 OS 注册身份或数据落盘标识符**的调用点,都必须传本构建的档案——漏传
 * 一个就会静默退回公开版档案(`BRAND_IDENTITY`),后果按严重度排列:
 *
 *  - `brandUserDataDirName` 漏传 → 内网版与公开版**共用同一份 userData**
 *    (数据库 / 凭据 / 单实例锁全部串台)。这是最容易漏、后果最重的一处。
 *  - `allUserDataDirNames` 漏传 → 进程标记指向另一份安装的目录,
 *    `claude-orphan-reaper` 等按路径认领进程的消费点会误杀。
 *  - `brandExecutableName` / `allDeepLinkSchemes` 漏传 → 安装目录、快捷方式、
 *    深链协议与公开版互抢。
 *
 * 本模块的存在就是为了让"漏传"变成"不可能":把 identity 在这里绑死,对消费方
 * 暴露**与 maker-shared 同名同参数表**的访问器。消费方只改 import 源,
 * 不改调用行;`brandIdentityUsageGuard.test.ts` 静态拦下任何绕过本模块、
 * 直接从 maker-shared 取这些符号的新代码。
 *
 * ⚠️ 语义边界:
 *  - 本模块**不解析 region**:region 由 `brandRegion.ts` 的 `CURRENT_CINDY_REGION`
 *    从同一份构建期烘焙值解析。两者的入参 `region` 都是为了保持与 maker-shared
 *    同签名(便于就地替换),由调用方传入。
 *  - 只暴露 identity 派生访问器。**不要**在这里 re-export maker-shared 的
 *    `BRAND_IDENTITY`——那会让"公开版档案"在多一个文件里可用,正是本模块要收掉的
 *    东西。需要本构建档案请用 `CURRENT_BRAND_IDENTITY`。
 *  - 不承担能力判断:能力集在 `cindyEdition.ts`。
 */

import {
  DEFAULT_CINDY_REGION,
  allDeepLinkSchemes as allDeepLinkSchemesFor,
  allUserDataDirNames as allUserDataDirNamesFor,
  brandAppId as brandAppIdFor,
  brandBundleIdPrefix as brandBundleIdPrefixFor,
  brandExecutableName as brandExecutableNameFor,
  brandUserDataDirName as brandUserDataDirNameFor,
  brandIdentityForEdition,
  legacyBrandUserDataDirNames as legacyBrandUserDataDirNamesFor,
  legacyDialogueUserDataDirNames as legacyDialogueUserDataDirNamesFor,
  type BrandIdentity,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_EDITION } from './cindyEdition.js';

/**
 * 本构建的标识符身份档案(按 edition 分派;`oss` 与引入 edition 维度前完全一致)。
 *
 * 这是桌面侧取身份档案的**唯一**入口。需要 `dbFilePrefix` / `executableName` /
 * `primaryScheme` / `userDataDirName` 等字段时读它,不要去 import maker-shared 的
 * `BRAND_IDENTITY`。
 */
export const CURRENT_BRAND_IDENTITY: BrandIdentity = brandIdentityForEdition(
  CURRENT_CINDY_EDITION,
);

/** 本构建的 appId(AUMID / bundle id),按区域取值。 */
export function brandAppId(region: CindyRegion = DEFAULT_CINDY_REGION): string {
  return brandAppIdFor(region, CURRENT_BRAND_IDENTITY);
}

/** 自有 UTI / ProgId 等派生标识的前缀,随区域 appId 走。 */
export function brandBundleIdPrefix(region: CindyRegion = DEFAULT_CINDY_REGION): string {
  return brandBundleIdPrefixFor(region, CURRENT_BRAND_IDENTITY);
}

/** 本构建的可执行文件基名(exe / .app / 安装目录 / 快捷方式名),按区域取值。 */
export function brandExecutableName(region: CindyRegion = DEFAULT_CINDY_REGION): string {
  return brandExecutableNameFor(region, CURRENT_BRAND_IDENTITY);
}

/** 本构建的 userData 目录名,按区域取值。 */
export function brandUserDataDirName(region: CindyRegion = DEFAULT_CINDY_REGION): string {
  return brandUserDataDirNameFor(region, CURRENT_BRAND_IDENTITY);
}

/** 本构建需注册/解析的全部深链 scheme(主 + 历史),顺序稳定:主 scheme 恒为首位。 */
export function allDeepLinkSchemes(): readonly string[] {
  return allDeepLinkSchemesFor(CURRENT_BRAND_IDENTITY);
}

/** 本构建按路径识别自身 userData 的全部目录名(本区域当前 + 本区域拥有的历史名)。 */
export function allUserDataDirNames(region: CindyRegion = DEFAULT_CINDY_REGION): readonly string[] {
  return allUserDataDirNamesFor(region, CURRENT_BRAND_IDENTITY);
}

/** 本构建用于数据迁移识别的历史 userData 目录名(跨区域共享那批)。 */
export function legacyBrandUserDataDirNames(): readonly string[] {
  return legacyBrandUserDataDirNamesFor(CURRENT_BRAND_IDENTITY);
}

/** 本构建按区域取持久化 dialogue cwd 的历史 userData 目录名。仅供数据迁移。 */
export function legacyDialogueUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
): readonly string[] {
  return legacyDialogueUserDataDirNamesFor(region, CURRENT_BRAND_IDENTITY);
}
