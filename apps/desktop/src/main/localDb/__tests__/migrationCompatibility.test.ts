import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  alignRenumberedAppliedMigrationIdentities,
  checkMigrationCompatibility,
  hashMigrationFile,
  MigrationRuntimeManifestError,
  prepareMigrationRuntimeManifest,
} from '../migrationRunner';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDrizzleDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-passive-migrations-'));
  cleanupDirs.push(dir);
  writeFileSync(path.join(dir, '0000_init.sql'), 'CREATE TABLE first (id TEXT);\n', 'utf8');
  writeFileSync(path.join(dir, '0001_second.sql'), 'CREATE TABLE second (id TEXT);\n', 'utf8');
  return dir;
}

function createDb(schemaVersion: number, withHistory = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO migration_meta (key, value) VALUES ('schema_version', '${schemaVersion}');
  `);
  if (withHistory) {
    db.exec(`
      CREATE TABLE migration_history (
        seq INTEGER PRIMARY KEY NOT NULL,
        file_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

function seedExactHistory(db: Database.Database, drizzleDir: string): void {
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const fileName of ['0000_init.sql', '0001_second.sql']) {
    insert.run(
      Number(fileName.slice(0, 4)),
      fileName,
      hashMigrationFile(path.join(drizzleDir, fileName)),
      123,
    );
  }
}

describe('checkMigrationCompatibility', () => {
  it('accepts an exact schema version and migration history match', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);

      expect(checkMigrationCompatibility(db, drizzleDir)).toEqual({
        compatible: true,
        databaseVersion: 1,
        checkoutVersion: 1,
        issues: [],
      });
    } finally {
      db.close();
    }
  });

  it('rejects a database with pending checkout migrations', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(0);
    try {
      const first = '0000_init.sql';
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, first, hashMigrationFile(path.join(drizzleDir, first)), 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'schema-version-behind',
        'history-entry-missing',
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects a database newer than the checkout', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(2);
    try {
      seedExactHistory(db, drizzleDir);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues).toEqual([
        { kind: 'schema-version-ahead', databaseVersion: 2, checkoutVersion: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects drifted, missing, or unexpected migration history entries', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(0, '0000_renamed.sql', 'wrong-hash', 123);
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(99, '0099_future.sql', 'future-hash', 123);

      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toEqual([
        'history-entry-mismatch',
        'history-entry-missing',
        'history-entry-unexpected',
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed when migration_history is unavailable', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1, false);
    try {
      const report = checkMigrationCompatibility(db, drizzleDir);
      expect(report.compatible).toBe(false);
      expect(report.issues[0]?.kind).toBe('history-unavailable');
    } finally {
      db.close();
    }
  });

  it.each(['abc', '1junk', '9007199254740992', '-1', '01'])(
    'fails closed for an invalid schema_version value: %s',
    (value) => {
      const drizzleDir = createDrizzleDir();
      const db = createDb(1);
      try {
        seedExactHistory(db, drizzleDir);
        db.prepare(`UPDATE migration_meta SET value=? WHERE key='schema_version'`).run(value);

        const report = checkMigrationCompatibility(db, drizzleDir);
        expect(report.compatible).toBe(false);
        expect(report.databaseVersion).toBe(-1);
        expect(report.issues.map((issue) => issue.kind)).toContain('history-unavailable');
      } finally {
        db.close();
      }
    },
  );

  it('includes companion TS scripts in the persisted runtime identity', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "first"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);

      writeFileSync(scriptPath, 'export function run() { return "changed"; }\n', 'utf8');
      const report = checkMigrationCompatibility(db, drizzleDir, dbFilePath);
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-mismatch');
    } finally {
      db.close();
    }
  });

  it('never overwrites the identity of an already applied companion TS migration', () => {
    const drizzleDir = createDrizzleDir();
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = path.join(scriptsDir, '0001_second.ts');
    writeFileSync(scriptPath, 'export function run() { return "applied-a"; }\n', 'utf8');
    const dbFilePath = path.join(drizzleDir, 'shared.db');

    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
    writeFileSync(scriptPath, 'export function run() { return "checkout-b"; }\n', 'utf8');

    expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).toThrow(
      /applied migration runtime identity changed at seq 1/,
    );
  });

  it('classifies an application missing an applied migration without weakening the guard', () => {
    const drizzleDir = createDrizzleDir();
    const dbFilePath = path.join(drizzleDir, 'shared.db');
    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
    rmSync(path.join(drizzleDir, '0001_second.sql'));

    try {
      prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1);
      throw new Error('expected a missing applied migration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationRuntimeManifestError);
      expect(error).toMatchObject({
        code: 'applied-migration-missing-from-application',
        seq: 1,
        fileName: '0001_second.sql',
      });
      expect((error as Error).message).toContain('current application is missing applied migration');
    }
  });

  it('normalizes the known bad 0062 companion identity back to canonical', () => {
    const sourceDrizzleDir = path.resolve(__dirname, '../../../../drizzle');
    const drizzleDir = mkdtempSync(path.join(tmpdir(), 'cindy-runtime-identity-repair-'));
    cleanupDirs.push(drizzleDir);
    const scriptsDir = path.join(drizzleDir, 'scripts');
    mkdirSync(scriptsDir);

    const fileName = '0062_flaky_mimic.sql';
    const sqlPath = path.join(drizzleDir, fileName);
    const scriptPath = path.join(scriptsDir, '0062_flaky_mimic.ts');
    const canonicalScript = readFileSync(
      path.join(sourceDrizzleDir, 'scripts', '0062_flaky_mimic.ts'),
      'utf8',
    );
    const badScript = canonicalScript.replace('@lizi/maker-scheduler', '@cindy/maker-scheduler');
    writeFileSync(sqlPath, readFileSync(path.join(sourceDrizzleDir, fileName), 'utf8'), 'utf8');
    writeFileSync(scriptPath, badScript, 'utf8');

    expect(hashMigrationFile(sqlPath)).toBe(
      '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68',
    );
    expect(hashMigrationFile(scriptPath)).toBe(
      '0ea82003cac0419a4a483b0afc1743d6fdba0b50085104720d5b2561e721072d',
    );

    const dbFilePath = path.join(drizzleDir, 'shared.db');
    prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62);
    writeFileSync(scriptPath, canonicalScript, 'utf8');
    expect(hashMigrationFile(scriptPath)).toBe(
      '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
    );

    const db = createDb(62);
    try {
      db.prepare(
        `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(62, fileName, hashMigrationFile(sqlPath), 123);

      expect(checkMigrationCompatibility(db, drizzleDir, dbFilePath).compatible).toBe(true);
      expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 62)).not.toThrow();
      const repaired = JSON.parse(readFileSync(`${dbFilePath}.migration-runtime.json`, 'utf8')) as {
        migrations: Array<{ scriptHash: string | null }>;
      };
      expect(repaired.migrations[0]?.scriptHash).toBe(
        '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78',
      );
    } finally {
      db.close();
    }
  });

  it('fails closed when the runtime identity has not been published by a primary', () => {
    const drizzleDir = createDrizzleDir();
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      const report = checkMigrationCompatibility(
        db,
        drizzleDir,
        path.join(drizzleDir, 'missing.db'),
      );
      expect(report.compatible).toBe(false);
      expect(report.issues.map((issue) => issue.kind)).toContain('runtime-manifest-unavailable');
    } finally {
      db.close();
    }
  });
});

describe('alignRenumberedAppliedMigrationIdentities', () => {
  function seedSwappedHistory(
    db: Database.Database,
    drizzleDir: string,
  ): void {
    const insert = db.prepare(
      `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
       VALUES (?, ?, ?, ?)`,
    );
    // 旧口径把两个迁移的编号记反了：0001 记在 seq 0，0000 记在 seq 1。
    insert.run(
      0,
      '0001_second.sql',
      hashMigrationFile(path.join(drizzleDir, '0001_second.sql')),
      123,
    );
    insert.run(
      1,
      '0000_init.sql',
      hashMigrationFile(path.join(drizzleDir, '0000_init.sql')),
      123,
    );
  }

  function writeSwappedManifest(dbFilePath: string, drizzleDir: string): void {
    const manifest = {
      version: 1,
      legacyBaselineVersion: -1,
      migrations: [
        {
          seq: 0,
          fileName: '0001_second.sql',
          sqlHash: hashMigrationFile(path.join(drizzleDir, '0001_second.sql')),
          scriptHash: null,
        },
        {
          seq: 1,
          fileName: '0000_init.sql',
          sqlHash: hashMigrationFile(path.join(drizzleDir, '0000_init.sql')),
          scriptHash: null,
        },
      ],
    };
    writeFileSync(
      `${dbFilePath}.migration-runtime.json`,
      `${JSON.stringify(manifest)}\n`,
      'utf8',
    );
  }

  it('realigns a renumbered history so the identity gate lets the upgrade through', () => {
    const drizzleDir = createDrizzleDir();
    const dbFilePath = path.join(drizzleDir, 'owner.db');
    const db = createDb(1);
    try {
      seedSwappedHistory(db, drizzleDir);
      writeSwappedManifest(dbFilePath, drizzleDir);

      const result = alignRenumberedAppliedMigrationIdentities(db, dbFilePath, drizzleDir, 1);
      expect(result.aligned).toBe(true);
      expect(result.renumbered).toEqual([
        { from: 0, to: 1, fileName: '0001_second.sql' },
        { from: 1, to: 0, fileName: '0000_init.sql' },
      ]);

      const history = db
        .prepare(`SELECT seq, file_name FROM migration_history ORDER BY seq`)
        .all() as Array<{ seq: number; file_name: string }>;
      expect(history).toEqual([
        { seq: 0, file_name: '0000_init.sql' },
        { seq: 1, file_name: '0001_second.sql' },
      ]);

      expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('keeps failing closed when the applied content hash differs', () => {
    const drizzleDir = createDrizzleDir();
    const dbFilePath = path.join(drizzleDir, 'owner.db');
    const db = createDb(1);
    try {
      seedSwappedHistory(db, drizzleDir);
      writeSwappedManifest(dbFilePath, drizzleDir);
      const manifestPath = `${dbFilePath}.migration-runtime.json`;
      const tampered = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        migrations: Array<{ sqlHash: string }>;
      };
      tampered.migrations[0].sqlHash = 'f'.repeat(64);
      writeFileSync(manifestPath, `${JSON.stringify(tampered)}\n`, 'utf8');

      const result = alignRenumberedAppliedMigrationIdentities(db, dbFilePath, drizzleDir, 1);
      expect(result.aligned).toBe(false);
      expect(() => prepareMigrationRuntimeManifest(dbFilePath, drizzleDir, 1)).toThrow(
        /runtime identity changed/,
      );
    } finally {
      db.close();
    }
  });

  it('leaves an already aligned history untouched', () => {
    const drizzleDir = createDrizzleDir();
    const dbFilePath = path.join(drizzleDir, 'owner.db');
    const db = createDb(1);
    try {
      seedExactHistory(db, drizzleDir);
      const result = alignRenumberedAppliedMigrationIdentities(db, dbFilePath, drizzleDir, 1);
      expect(result).toEqual({ aligned: false, renumbered: [] });
    } finally {
      db.close();
    }
  });
});
