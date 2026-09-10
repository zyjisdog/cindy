/**
 * cindyEdition — 本构建的**发行版本身份**与能力快照的运行时单点。
 *
 * 与 `brandRegion.ts` 平行的第二个构建期身份维度(两者正交):
 *   - `brandRegion.ts`  = 面向哪个市场(cn/global/dev),决定端点与系统身份;
 *   - 本文件            = 这一版装了什么能力(oss/intranet)。
 *
 * edition 在**构建期**经 `VITE_CINDY_EDITION` 烘焙(main 走 vite.main.config.ts 的
 * define,renderer 走 Vite 标准 env;生产由 `desktopClientBuildEnv` 注入,dev /
 * 未注入一律默认 `oss`)。运行时不可切换。
 *
 * ⚠️ 能力开关的定位(不要误用):
 *  - 它表达"该能力**是否随本版发行**",因此**必须**与真实删除/裁剪配套使用。
 *    大多数需求(计费、语音、IM、市场、遥测)按实施方案是**真删除**,本开关只是
 *    给跨模块的判断点和少数需要保留代码的位置一个单一事实源。
 *  - 它**不是**权限、不是用户偏好、不是 feature flag(没有开关 UI,也不能运行期改)。
 *  - 不要把"能靠打包器 tree-shake"当成"已经删掉了":`CURRENT_EDITION_CAPABILITIES`
 *    是对象查表,能否折叠成字面量取决于打包器对跨模块常量传播的能力。**体积与
 *    行为上的确定性来自真删除**,开关只负责让判断点统一且可读。
 */

import {
  editionCapabilities,
  resolveCindyEdition,
  type CindyEdition,
  type EditionCapabilities,
} from '@cindy/maker-shared/cindy-edition';

/**
 * 本构建的发行版本(构建期烘焙;未注入默认 `oss`)。
 *
 * 非法注入值会让 `resolveCindyEdition` 直接抛错 —— 与 region 同规矩:
 * 打包链路宁可失败,也不能默默打出能力集错误的包。
 */
export const CURRENT_CINDY_EDITION: CindyEdition = resolveCindyEdition(
  import.meta.env?.VITE_CINDY_EDITION,
);

/** 本构建的能力快照。判断"某能力是否随本版发行"一律读这里,不要在调用点重算 edition。 */
export const CURRENT_EDITION_CAPABILITIES: EditionCapabilities =
  editionCapabilities(CURRENT_CINDY_EDITION);

/** 本构建是否内网版(等价于 `CURRENT_CINDY_EDITION === 'intranet'`)。 */
export const IS_INTRANET_EDITION: boolean = CURRENT_CINDY_EDITION === 'intranet';
