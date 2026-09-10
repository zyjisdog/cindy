import { describe, expect, it } from 'vitest';
import {
  BRAND_IDENTITY,
  INTRANET_BRAND_IDENTITY,
  brandAppId,
  brandExecutableName,
  brandIdentityForEdition,
  brandUserDataDirName,
  allDeepLinkSchemes,
  type CindyRegion,
} from '../brandIdentity.js';
import {
  DEFAULT_CINDY_EDITION,
  EDITION_CAPABILITIES,
  editionCapabilities,
  isOfflineSelfSufficient,
  resolveCindyEdition,
  type CindyEdition,
} from '../cindyEdition.js';

const ALL_EDITIONS: readonly CindyEdition[] = ['oss', 'intranet'];
const ALL_REGIONS: readonly CindyRegion[] = ['cn', 'global', 'dev'];

/**
 * edition 是**第二个构建期维度**(与 region 正交)。这组测试锁住三件
 * typecheck 拦不住的事:
 *  1) 引入 edition 不得改变公开版行为(oss 全开、身份对象引用不变);
 *  2) intranet 身份必须在系统层与公开版零碰撞(appId / exe / userData / scheme);
 *  3) intranet **不**能悄悄改更新器名 —— 那要过 cindy-updater.md 的门。
 */
describe('resolveCindyEdition', () => {
  it('缺省落 oss(与 region 缺省落 global 同向,不落 intranet)', () => {
    expect(DEFAULT_CINDY_EDITION).toBe('oss');
    expect(resolveCindyEdition(undefined)).toBe('oss');
    expect(resolveCindyEdition(null)).toBe('oss');
    expect(resolveCindyEdition('')).toBe('oss');
    expect(resolveCindyEdition('   ')).toBe('oss');
  });

  it('归一化大小写与空白', () => {
    expect(resolveCindyEdition('intranet')).toBe('intranet');
    expect(resolveCindyEdition(' Intranet ')).toBe('intranet');
    expect(resolveCindyEdition('OSS')).toBe('oss');
  });

  it('非法值 fail closed(宁可打包失败也不发出能力集错误的包)', () => {
    for (const invalid of ['0ss', 'personal', 'intranet2', 'internal', 'dev']) {
      expect(() => resolveCindyEdition(invalid)).toThrow(/Invalid Cindy edition/);
    }
  });
});

describe('EDITION_CAPABILITIES', () => {
  it('oss 全开 —— 引入 edition 维度不得删减公开发行版任何能力', () => {
    // 任何 oss: false 都等于在默认构建上删功能,必须是有独立产品裁决的动作。
    // 这条断言的作用就是把"顺手改成 false"拦在 review 之前。
    for (const [name, enabled] of Object.entries(EDITION_CAPABILITIES.oss)) {
      expect(enabled, `oss.${name} 必须为 true`).toBe(true);
    }
  });

  it('intranet 按需求关闭对应能力,并保留离线自足项', () => {
    const caps = EDITION_CAPABILITIES.intranet;
    // 需求 1 账号登录 / 需求 2 预设供应商与云端目录 / 需求 3 计费
    expect(caps.accountLogin).toBe(false);
    expect(caps.vendorSubscriptionLogin).toBe(false);
    expect(caps.presetModelProviders).toBe(false);
    expect(caps.cloudModelCatalog).toBe(false);
    expect(caps.billing).toBe(false);
    // 需求 4 语音输入与 IM 机器人
    expect(caps.voiceInput).toBe(false);
    expect(caps.imBots).toBe(false);
    // 需求 5 同账号设备互联
    expect(caps.sameAccountDeviceLink).toBe(false);
    // 需求 6 公开插件与公开技能
    expect(caps.publicPluginMarket).toBe(false);
    expect(caps.publicSkillHub).toBe(false);
    // 需求 7 第三方聊天工具(飞书 / 微信 / Slack)
    expect(caps.thirdPartyChatTools).toBe(false);
    // 需求 8 遥测
    expect(caps.telemetry).toBe(false);
    // 需求 9 内置运行时依赖
    expect(caps.bundledToolchain).toBe(true);
    // D7 自动更新:关。但接线要过 cindy-updater.md 的门,见下方 updaterName 断言。
    expect(caps.autoUpdate).toBe(false);
  });

  it('两版能力集的键完全一致(新增能力必须同时决定两版取值)', () => {
    // 防止只给一个 edition 加字段,另一个靠 undefined 兜底——那会把"忘了决定"
    // 表现成"偶尔为 false",在核心路径上极难排查。
    expect(Object.keys(EDITION_CAPABILITIES.oss).sort()).toEqual(
      Object.keys(EDITION_CAPABILITIES.intranet).sort(),
    );
    for (const edition of ALL_EDITIONS) {
      for (const value of Object.values(EDITION_CAPABILITIES[edition])) {
        expect(typeof value).toBe('boolean');
      }
    }
  });

  it('editionCapabilities 默认 oss;isOfflineSelfSufficient 只对无账号版为真', () => {
    expect(editionCapabilities()).toBe(EDITION_CAPABILITIES.oss);
    expect(editionCapabilities('intranet')).toBe(EDITION_CAPABILITIES.intranet);
    expect(isOfflineSelfSufficient('oss')).toBe(false);
    expect(isOfflineSelfSufficient('intranet')).toBe(true);
  });
});

describe('brandIdentityForEdition', () => {
  it('oss 返回公开版档案本体(零行为变化)', () => {
    expect(brandIdentityForEdition('oss')).toBe(BRAND_IDENTITY);
    expect(brandIdentityForEdition()).toBe(BRAND_IDENTITY);
  });

  it('intranet 返回内网版档案', () => {
    expect(brandIdentityForEdition('intranet')).toBe(INTRANET_BRAND_IDENTITY);
  });

  it('intranet 与公开版在系统层零碰撞(appId / exe / userData / scheme)', () => {
    // 这是 D3「改名」的验收断言:同机装两份时,两份安装不得争抢同一份用户数据、
    // 同一个系统身份、同一个深链协议。
    for (const region of ALL_REGIONS) {
      expect(brandAppId(region, INTRANET_BRAND_IDENTITY)).not.toBe(
        brandAppId(region, BRAND_IDENTITY),
      );
      expect(brandExecutableName(region, INTRANET_BRAND_IDENTITY)).not.toBe(
        brandExecutableName(region, BRAND_IDENTITY),
      );
      expect(brandUserDataDirName(region, INTRANET_BRAND_IDENTITY)).not.toBe(
        brandUserDataDirName(region, BRAND_IDENTITY),
      );
      // 内网版所有区域取同值:它没有 cn/global 市场分化。同值是**有意**语义。
      expect(brandAppId(region, INTRANET_BRAND_IDENTITY)).toBe(
        brandAppId('global', INTRANET_BRAND_IDENTITY),
      );
      expect(brandExecutableName(region, INTRANET_BRAND_IDENTITY)).toBe(
        brandExecutableName('global', INTRANET_BRAND_IDENTITY),
      );
      expect(brandUserDataDirName(region, INTRANET_BRAND_IDENTITY)).toBe(
        brandUserDataDirName('global', INTRANET_BRAND_IDENTITY),
      );
    }

    // 内网版不得注册公开版的深链 scheme,否则同机装两份时会抢走公开版的链接。
    const publicSchemes = new Set(allDeepLinkSchemes(BRAND_IDENTITY));
    for (const scheme of allDeepLinkSchemes(INTRANET_BRAND_IDENTITY)) {
      expect(publicSchemes.has(scheme), `intranet 不得占用公开版 scheme: ${scheme}`).toBe(false);
    }
  });

  it('intranet 不认领任何公开版的历史数据目录 / scheme / DB 前缀', () => {
    // 内网版是全新安装,没有历史包袱。若它把公开版的历史名纳入自己的候选集,
    // orphan-reaper 等按路径匹配的消费点就会去动公开版的数据。
    expect(INTRANET_BRAND_IDENTITY.legacyUserDataDirNames).toEqual([]);
    expect(INTRANET_BRAND_IDENTITY.legacySchemes).toEqual([]);
    expect(INTRANET_BRAND_IDENTITY.legacyDbFilePrefixes).toEqual([]);
    for (const region of ALL_REGIONS) {
      expect(INTRANET_BRAND_IDENTITY.legacyUserDataDirNamesByRegion[region]).toEqual([]);
      expect(INTRANET_BRAND_IDENTITY.legacyDialogueUserDataDirNamesByRegion[region]).toEqual([]);
    }
  });

  it('两版区域映射键集都恰为 cn/dev/global', () => {
    // scripts/__tests__/brand-identity-sync.test.mjs 用正则从源码抽这些映射并要求
    // 键集恰为这三个。这里在运行时再锁一道:把 intranet 误做成「第四个区域键」
    // 是最容易犯的设计错误(它应是 edition,不是 region)。
    for (const identity of [BRAND_IDENTITY, INTRANET_BRAND_IDENTITY]) {
      for (const map of [
        identity.executableNameByRegion,
        identity.appIdByRegion,
        identity.userDataDirNameByRegion,
        identity.legacyUserDataDirNamesByRegion,
        identity.legacyDialogueUserDataDirNamesByRegion,
      ]) {
        expect(Object.keys(map).sort()).toEqual(['cn', 'dev', 'global']);
      }
    }
  });

  it('两版 updaterName 相同 —— 内网版不碰更新链路', () => {
    // docs/dev-rules/cindy-updater.md:任何更新链路改动必须先与仓库维护者确认。
    // 内网版按 D7 关闭自动更新(autoUpdate: false),更新器不会被调用,因此改这个名
    // 没有功能收益却会实打实碰更新链路 —— 故意保持同值。
    // 将来若要做内网自更新,必须同时改 updateService 并先过那道门;这条断言会
    // 主动失败,提醒来人别只改一半。
    expect(INTRANET_BRAND_IDENTITY.updaterName).toBe(BRAND_IDENTITY.updaterName);
  });

  it('两版标识符都满足各自文件安全约束', () => {
    const fileSafe = /^[a-z0-9][a-z0-9-]*$/;
    const dirSafe = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    const appIdSafe = /^[a-z0-9][a-z0-9.-]*$/;
    for (const identity of [BRAND_IDENTITY, INTRANET_BRAND_IDENTITY]) {
      expect(identity.cdnPrefix).toMatch(fileSafe);
      expect(identity.dbFilePrefix).toMatch(fileSafe);
      expect(identity.updaterName).toMatch(fileSafe);
      expect(identity.executableName).toMatch(dirSafe);
      expect(identity.userDataDirName).toMatch(dirSafe);
      for (const region of ALL_REGIONS) {
        expect(identity.executableNameByRegion[region]).toMatch(dirSafe);
        expect(identity.userDataDirNameByRegion[region]).toMatch(dirSafe);
        expect(identity.appIdByRegion[region]).toMatch(appIdSafe);
      }
    }
  });
});
