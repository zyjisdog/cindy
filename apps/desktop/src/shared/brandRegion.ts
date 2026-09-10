/**
 * brandRegion — 本构建的区域身份(cn/global)与区域派生 appId 的运行时单点。
 *
 * 区域在**构建期**经 VITE_CINDY_AUTH_REGION 烘焙(main 走 vite.main.config.ts
 * 的 define,renderer 走标准 Vite env;生产由 desktopClientBuildEnv 注入,dev /
 * 未注入一律默认 global)。运行时不可切换——cn 与 global 是两个可并存的系统身份
 * (com.xd.cindycn / com.xd.cindy,与 mobile 同一套命名)。
 *
 * ⚠️ AUMID 三位一体:本文件的 CURRENT_APP_ID 必须与 NSIS appId(forge.config
 * 按同一 region+edition 从 brandAppId() 取值)、快捷方式 AUMID 逐字符一致,否则
 * Windows toast 通知被静默丢弃。
 *
 * 本文件只负责 **region 解析** 与 `CURRENT_APP_ID`。identity 档案与其派生访问器
 * 在 `currentBrandIdentity.ts`(那里把 edition 绑死,避免漏传 identity 退回公开版)。
 * appId 的完整派生链是 `brandAppId(region) + CURRENT_BRAND_IDENTITY`,即
 * `brandAppId(region, brandIdentityForEdition(edition))`;forge / main /
 * 快捷方式三方必须同源。
 */

import {
  resolveCindyRegion,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

import { CURRENT_BRAND_IDENTITY, brandAppId } from './currentBrandIdentity.js';

export { CURRENT_BRAND_IDENTITY };

/** 本构建的区域(构建期烘焙;dev 默认 global)。 */
export const CURRENT_CINDY_REGION: CindyRegion = resolveCindyRegion(
  import.meta.env?.VITE_CINDY_AUTH_REGION,
);

/** 本构建的系统身份 id(Windows AUMID / macOS bundle id)。 */
export const CURRENT_APP_ID: string = brandAppId(CURRENT_CINDY_REGION);
