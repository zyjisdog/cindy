/**
 * 标识符身份使用守门(静态断言)。
 *
 * edition 维度上线后,`@cindy/maker-shared/brand-identity` 的每个取值函数都接受
 * `(region, identity)`。桌面侧若**漏传 identity**,会静默退回公开版档案
 * (`BRAND_IDENTITY`),后果按严重度:
 *   - `brandUserDataDirName` 漏传 → 内网版与公开版共用同一份 userData;
 *   - `allUserDataDirNames` 漏传 → 进程标记指向另一份安装,orphan-reaper 误杀;
 *   - `brandExecutableName` / `allDeepLinkSchemes` 漏传 → 安装目录 / 快捷方式 /
 *     深链协议互抢。
 *
 * 这类漏传**不报错、typecheck 拦不住**(identity 参数是可选参数),只有跑到
 * "两份安装在同一台机器上"时才暴露。因此用静态断言把它钉死:
 * 桌面侧只能从 `src/shared/currentBrandIdentity.ts`(那里 identity 已绑死)取这些
 * 符号,不得直接 import maker-shared 的版本。
 *
 * 与 `src/main/__tests__/endpointEnvUsageGuard.test.ts` 同一套路:扫描源码 + 白名单,
 * 白名单外命中即失败。白名单只有两项且都有明确红线理由,见下。
 *
 * 顺带守住一个**已真实发生过**的 bug:forge.config.ts 曾有两处 `allDeepLinkSchemes()`
 * 不传 identity,会让内网版注册公开版的 `cindy://` scheme(同机双装互抢深链)。
 * 第二条用例静态要求 forge 里每个 identity 派生调用都显式传 `CINDY_IDENTITY`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP_ROOT = path.resolve(SRC_ROOT, '..');
const FORGE_CONFIG = path.join(DESKTOP_ROOT, 'forge.config.ts');
const MAKER_SHARED_PKG = '@cindy/maker-shared/brand-identity';

/** 需要 edition 绑定的 identity 符号(取值时依赖 identity 档案)。 */
const IDENTITY_SYMBOLS = [
  'BRAND_IDENTITY',
  'brandAppId',
  'brandBundleIdPrefix',
  'brandExecutableName',
  'brandUserDataDirName',
  'allDeepLinkSchemes',
  'allUserDataDirNames',
  'legacyBrandUserDataDirNames',
  'legacyDialogueUserDataDirNames',
];

/**
 * 允许直连 maker-shared 的**生产**文件(相对 SRC_ROOT)。每项都必须有红线理由:
 *
 * - `shared/currentBrandIdentity.ts` = 本守门的适配器本身,identity 在这里绑死。
 * - `main/updateService.ts` = 更新链路。`docs/dev-rules/cindy-updater.md` 规定任何
 *   更新链路改动必须先与仓库维护者确认;它只读 `updaterName`,而该字段两版**同值**
 *   (见 `brandIdentity.ts` 的 `INTRANET_BRAND_IDENTITY` 头注),没有 edition 分派需求。
 *   将来要接内网自更新时,必须先过那道门再动这里。
 * - `main/devKeychainName.ts` = 凭证存储(safeStorage 钥匙串条目命名),归
 *   `docs/dev-rules/credentials-and-local-storage.md` 管;且它在 `isPackaged` 时
 *   直接短路(`keep-default`),只影响未打包的 dev 沙箱,不进入任何发行包。
 *
 * 注意 `shared/brandRegion.ts` **不在**名单里:它只做 region 解析与 appId,identity
 * 派生走适配器。
 */
const ALLOWED_PRODUCTION_FILES = new Set([
  path.join('shared', 'currentBrandIdentity.ts'),
  path.join('main', 'updateService.ts'),
  path.join('main', 'devKeychainName.ts'),
]);

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes(`${path.sep}__tests__${path.sep}`) ||
    /\.(test|spec)\.(ts|tsx)$/.test(relPath)
  );
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/**
 * 抽出源码里从 `@cindy/maker-shared/brand-identity` import 的**具名符号**。
 * 同时匹配单行与多行 import 块;`type X` 形式(纯类型)不算——类型不携带取值。
 */
function importedIdentitySymbols(source: string): string[] {
  const found: string[] = [];
  const importRe = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${MAKER_SHARED_PKG.replace('/', '\\/')}['"]`,
    'g',
  );
  for (const match of source.matchAll(importRe)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (!name) continue;
      if (IDENTITY_SYMBOLS.includes(name)) found.push(name);
    }
  }
  return found;
}

describe('标识符身份只能从 edition-bound 适配器取', () => {
  it('生产代码无越权直接 import(测试文件与白名单除外)', () => {
    const violations: string[] = [];
    for (const file of walkSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      if (isTestFile(rel) || ALLOWED_PRODUCTION_FILES.has(rel)) continue;
      const symbols = importedIdentitySymbols(fs.readFileSync(file, 'utf8'));
      if (symbols.length > 0) violations.push(`${rel} → ${[...new Set(symbols)].join(', ')}`);
    }
    expect(
      violations,
      '以下生产文件直接从 @cindy/maker-shared/brand-identity 取 identity 符号，' +
        '漏传 identity 会静默退回公开版档案。请改从 src/shared/currentBrandIdentity.ts import:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('forge.config.ts 的 identity 派生调用都显式传 CINDY_IDENTITY', () => {
    // 回归点:此前 allDeepLinkSchemes() 两处漏传 identity，内网版会注册公开版
    // 深链 scheme。这里静态要求这些函数**不出现无参调用**。
    const source = fs.readFileSync(FORGE_CONFIG, 'utf8');
    const bareCallRe =
      /\b(brandAppId|brandBundleIdPrefix|brandExecutableName|brandUserDataDirName|allDeepLinkSchemes|allUserDataDirNames|legacyBrandUserDataDirNames|legacyDialogueUserDataDirNames)\(\s*\)/g;
    const bare = [...source.matchAll(bareCallRe)].map((m) => m[0]);
    expect(
      bare,
      `forge.config.ts 存在无参 identity 调用(会退回公开版档案): ${bare.join(', ')}`,
    ).toEqual([]);

    // appId / exe / scheme 三处关键派生必须带 CINDY_IDENTITY。逐条列出而不是
    // 泛化成"函数名后跟 CINDY_IDENTITY",是因为 region-only 的首参形式
    // (如 brandAppId(CINDY_REGION))同样会漏 identity,而它带参数、上面那条抓不到。
    for (const expected of [
      'brandAppId(CINDY_REGION, CINDY_IDENTITY)',
      'brandBundleIdPrefix(CINDY_REGION, CINDY_IDENTITY)',
      'brandExecutableName(CINDY_REGION, CINDY_IDENTITY)',
      'allDeepLinkSchemes(CINDY_IDENTITY)',
    ]) {
      expect(source, `forge.config.ts 缺少 edition-bound 派生: ${expected}`).toContain(expected);
    }
  });

  it('适配器本身存在且确实绑定了 edition(防改名后守门空转)', () => {
    const adapter = path.join(SRC_ROOT, 'shared', 'currentBrandIdentity.ts');
    expect(fs.existsSync(adapter), 'shared/currentBrandIdentity.ts').toBe(true);
    const source = fs.readFileSync(adapter, 'utf8');
    expect(source).toContain('brandIdentityForEdition');
    expect(source).toContain('CURRENT_CINDY_EDITION');
    // 不得把公开版档案 re-export 出去——那等于多开一个拿到它的口子。
    expect(source).not.toMatch(/export\s+\{[^}]*\bBRAND_IDENTITY\b[^}]*\}/);
  });

  it('文件契约守卫:本守门扫描的目录确实存在(防路径漂移后空转)', () => {
    expect(fs.existsSync(SRC_ROOT)).toBe(true);
    expect(fs.existsSync(FORGE_CONFIG)).toBe(true);
  });
});
