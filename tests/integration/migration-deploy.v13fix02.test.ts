import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_USER_ID, COMPAT_USER_ID } from "../../src/config/constants.js";
import {
  columnsOf,
  foreignKeyViolations,
  insertMessagePair,
  insertRequest,
  objectSql,
  openDatabase,
  rawCount,
} from "../migration-harness.js";
import type { RawDb } from "../migration-harness.js";

/**
 * V1.3-B4 FIX-02B:真实 `prisma migrate deploy` 演练(不接受手工 replay 替代)。
 *
 * migration-v13b4 已经证明「SQL 本身正确」;这里证明的是**部署动作**正确:
 * - B4-DEPLOY-01:拿真实 `data/database/app.db` 的**副本**跑真实 pending 全链;
 * - B4-DEPLOY-02:真实 runner 遇上 §46 的无主数据必须失败,且失败后不留半迁移、可修复后重跑。
 *
 * 红线:原库只 read / copy,每一次写都落在 OS 临时目录里的副本上。
 * app.db 是本机开发产物(不入 Git),没有它就整组跳过,不让 CI 因缺文件而红。
 */

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve("prisma/build/index.js");

const REPO = process.cwd();
const REAL_APP_DB = join(REPO, "data", "database", "app.db");
const SCHEMA = join(REPO, "prisma", "schema.prisma");
const MIGRATIONS_DIR = join(REPO, "prisma", "migrations");
const B4_MIGRATION = "20260911170000_v13_b4_conversation_owner_not_null";

/** 目录名升序即 Prisma 的施加顺序 */
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const PREFIX_MIGRATIONS = ALL_MIGRATIONS.filter((name) => name !== B4_MIGRATION);

const INDEX_NAMES = [
  "Conversation_providerConversationUrl_key",
  "Conversation_status_idx",
  "Conversation_updatedAt_idx",
  "Conversation_userId_status_updatedAt_idx",
];
const TRIGGER_NAMES = [
  "trg_active_request_blocks_conversation_status_change",
  "trg_active_request_requires_active_conversation",
];

/** B4 之前就存在的那 9 列(不含新增 userId)—— 守恒比较必须两侧都取得到 */
const HISTORY_SNAPSHOT = `
  SELECT "id" id, "title" title, "status" status, "provider" provider,
         "providerConversationUrl" providerConversationUrl,
         CAST("preferredModelKey" AS TEXT) preferredModelKey,
         CAST("createdAt" AS TEXT) createdAt, CAST("updatedAt" AS TEXT) updatedAt,
         CAST("deletedAt" AS TEXT) deletedAt
  FROM "Conversation" ORDER BY "id"`;

function fileUrl(path: string): string {
  return `file:${path.replace(/\\/g, "/")}`;
}

interface DeployResult {
  ok: boolean;
  output: string;
}

function runDeploy(args: string[], extraEnv: Record<string, string>): DeployResult {
  try {
    const stdout = execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (caught) {
    const err = caught as { stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      output: [err.message, err.stdout, err.stderr].filter(Boolean).join("\n"),
    };
  }
}

/** 仓库自身那份 prisma.config.ts + 全量 migrations;只通过 DATABASE_URL 换库 */
function deployAll(databaseUrl: string): DeployResult {
  return runDeploy(["migrate", "deploy", "--schema", SCHEMA], { DATABASE_URL: databaseUrl });
}

/**
 * 同一套真实 runner,但 migrations 目录只放 B4 之前的前缀。
 * `prisma.config.ts` 把 `migrations.path` 钉死在 `prisma/migrations`,`--schema` 改不动它,
 * 因此这里传一份 `--config`:绝对路径 + 纯对象(.mjs 无需 import prisma/config 也能被加载)。
 */
function deployPrefixOnly(databaseUrl: string, migrationsDir: string, configFile: string): DeployResult {
  writeFileSync(
    configFile,
    `export default ${JSON.stringify(
      {
        schema: SCHEMA,
        migrations: { path: migrationsDir },
        datasource: { url: databaseUrl },
      },
      null,
      2,
    )};\n`,
  );
  return runDeploy(["migrate", "deploy", "--config", configFile], {});
}

/** 官方恢复动作:宣告某次失败的迁移已回滚,之后 deploy 才会继续 */
function resolveRolledBack(migrationName: string, databaseUrl: string): DeployResult {
  return runDeploy(
    ["migrate", "resolve", "--rolled-back", migrationName, "--schema", SCHEMA],
    { DATABASE_URL: databaseUrl },
  );
}

function appliedMigrations(db: RawDb): string[] {
  return (
    db
      .prepare(
        `SELECT "migration_name" n FROM "_prisma_migrations"
          WHERE "finished_at" IS NOT NULL ORDER BY "started_at"`,
      )
      .all() as { n: string }[]
  ).map((row) => row.n);
}

/** deploy 失败时 Prisma 留在 _prisma_migrations 里的那条记录(报告 §6 要看原文) */
function migrationRow(db: RawDb, name: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT "migration_name" name, "finished_at" finishedAt, "rolled_back_at" rolledBackAt,
              "applied_steps_count" steps, "logs" logs
         FROM "_prisma_migrations" WHERE "migration_name" = ?`,
    )
    .get(name) as Record<string, unknown> | undefined;
}

function objectNames(db: RawDb, type: "table" | "index" | "trigger", table?: string): string[] {
  const scope = table === undefined ? "" : `AND "tbl_name" = '${table}'`;
  return (
    db
      .prepare(
        `SELECT "name" n FROM sqlite_master WHERE "type" = '${type}' ${scope}
           AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all() as { n: string }[]
  ).map((row) => row.n);
}

function historyRows(db: RawDb): Record<string, unknown>[] {
  return db.prepare(HISTORY_SNAPSHOT).all() as Record<string, unknown>[];
}

/** §42:触发器只查名字不算验收,这里跑真实行为 TRG-01 / 01N / 02 / 02N */
function assertTriggerBehaviour(db: RawDb, owner: string): void {
  function prepared(conversationId: string, status: string): void {
    db.exec(
      `INSERT INTO "Conversation" ("id","title","status","createdAt","updatedAt","userId")
       VALUES ('${conversationId}','t','${status}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'${owner}')`,
    );
    const pair = insertMessagePair(db, conversationId, "x");
    insertRequest(db, {
      id: `req-${conversationId}`,
      conversationId,
      userMessageId: pair.userMessageId,
      assistantMessageId: pair.assistantMessageId,
      status: "SUCCESS",
    });
  }

  for (const status of ["ARCHIVED", "DELETED"]) {
    const id = `trg01-${status}`;
    prepared(id, status);
    const pair = insertMessagePair(db, id, "act", 3);
    expect(() =>
      insertRequest(db, {
        id: `req-active-${id}`,
        conversationId: id,
        userMessageId: pair.userMessageId,
        assistantMessageId: pair.assistantMessageId,
        status: "PENDING",
      }),
    ).toThrow(/model_request_active_requires_active_conversation/);
  }

  prepared("trg01n", "ACTIVE");
  const okPair = insertMessagePair(db, "trg01n", "act", 3);
  insertRequest(db, {
    id: "req-active-trg01n",
    conversationId: "trg01n",
    userMessageId: okPair.userMessageId,
    assistantMessageId: okPair.assistantMessageId,
    status: "PENDING",
  });
  expect(
    rawCount(db, `SELECT COUNT(*) c FROM "ModelRequest" WHERE "id" = 'req-active-trg01n'`),
  ).toBe(1);

  for (const status of ["ARCHIVED", "DELETED"]) {
    expect(() =>
      db.exec(`UPDATE "Conversation" SET "status" = '${status}' WHERE "id" = 'trg01n'`),
    ).toThrow(/active_request_blocks_conversation_status_change/);
  }

  prepared("trg02n", "ACTIVE");
  db.exec(`UPDATE "Conversation" SET "status" = 'ARCHIVED' WHERE "id" = 'trg02n'`);
  expect(
    (db.prepare(`SELECT "status" s FROM "Conversation" WHERE "id" = 'trg02n'`).get() as { s: string })
      .s,
  ).toBe("ARCHIVED");
}

describe.skipIf(!existsSync(REAL_APP_DB))(
  "V1.3-B4 FIX-02B 真实 migrate deploy 演练(副本)",
  () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "b4-deploy-"));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("B4-DEPLOY-01 真实 app.db 副本:runner 补齐 pending 全链且数据/结构/触发器无损", () => {
      const target = join(dir, "app.db");
      const pristine = join(dir, "pristine.db");
      copyFileSync(REAL_APP_DB, target);
      copyFileSync(REAL_APP_DB, pristine);

      const deployed = deployAll(fileUrl(target));
      expect(deployed.ok, deployed.output).toBe(true);

      const upgraded = openDatabase(target);
      const before = openDatabase(pristine);
      try {
        // 副本可能停在任意历史点(本机 app.db 会随开发推进),因此只断言「补齐到仓库最新」
        // 这一完整性事实,与施加顺序无关。
        expect(appliedMigrations(upgraded).slice().sort()).toEqual(ALL_MIGRATIONS);

        // §35/§36:userId 必填且没有默认值
        const userId = columnsOf(upgraded, "Conversation").find((c) => c.name === "userId")!;
        expect(userId.notnull).toBe(1);
        expect(userId.dflt_value).toBeNull();
        expect(
          rawCount(upgraded, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`),
        ).toBe(0);
        // B1 的回填语义在真实数据上成立:历史会话归固定 ADMIN,而不是随便某个 User。
        // 本机 app.db 的内容会随开发使用增长(COMPAT 主体也会拥有会话),因此这里断言
        // 「无主行为 0 + owner 只可能是两个固定哨兵之一 + ADMIN 确实在其中」,而非写死单值。
        const owners = (
          upgraded.prepare(`SELECT DISTINCT "userId" u FROM "Conversation" ORDER BY "userId"`).all() as {
            u: string;
          }[]
        ).map((row) => row.u);
        expect(owners.length).toBeGreaterThan(0);
        for (const owner of owners) expect([ADMIN_USER_ID, COMPAT_USER_ID]).toContain(owner);
        expect(owners).toContain(ADMIN_USER_ID);

        // 守恒:逐字段比较(时间列已 CAST 成文本),而不是只比行数
        expect(historyRows(upgraded)).toEqual(historyRows(before));
        for (const table of ["Conversation", "Message", "ModelRequest"]) {
          expect(
            rawCount(upgraded, `SELECT COUNT(*) c FROM "${table}"`),
            `row count drifted: ${table}`,
          ).toBe(rawCount(before, `SELECT COUNT(*) c FROM "${table}"`));
        }

        // §39/§40/§41:索引齐备、两条触发器都在、外键检查为空
        expect(objectNames(upgraded, "index", "Conversation")).toEqual(INDEX_NAMES);
        expect(objectNames(upgraded, "trigger")).toEqual(TRIGGER_NAMES);
        expect(foreignKeyViolations(upgraded)).toEqual([]);

        // 在真实升级产物上跑触发器行为(副本一次性,写入不影响上面的判据)
        assertTriggerBehaviour(upgraded, COMPAT_USER_ID);
        expect(foreignKeyViolations(upgraded)).toEqual([]);
      } finally {
        upgraded.close();
        before.close();
      }
    });

    it("B4-DEPLOY-02 真实 runner 遇无主数据必须失败,失败后不留半迁移且可按官方 resolve 恢复", () => {
      const target = join(dir, "half.db");

      // 前缀链同样交给真实 runner 施加:临时 migrations 目录只放 B4 之前的 5 个
      const prefixMigrations = join(dir, "prefix-migrations");
      mkdirSync(prefixMigrations, { recursive: true });
      for (const name of PREFIX_MIGRATIONS) {
        const to = join(prefixMigrations, name);
        mkdirSync(to, { recursive: true });
        copyFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), join(to, "migration.sql"));
      }
      const prefixDeploy = deployPrefixOnly(
        fileUrl(target),
        prefixMigrations,
        join(dir, "prefix.config.mjs"),
      );
      expect(prefixDeploy.ok, prefixDeploy.output).toBe(true);

      const probe = openDatabase(target);
      let rowsBefore: number;
      let tableSqlBefore: string;
      let indexesBefore: string[];
      let appliedBefore: string[];
      try {
        // B1 语义下仍然合法的无主行 —— 正是 §46 要求 B4 挡住的那种数据
        probe.exec(
          `INSERT INTO "Conversation" ("id","title","createdAt","updatedAt")
           VALUES ('orphan','无主会话',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        );
        rowsBefore = rawCount(probe, `SELECT COUNT(*) c FROM "Conversation"`);
        tableSqlBefore = objectSql(probe, "Conversation");
        indexesBefore = objectNames(probe, "index", "Conversation");
        appliedBefore = appliedMigrations(probe);
        expect(appliedBefore).toEqual(PREFIX_MIGRATIONS);
        // B1 语义:列已存在但可空 ⇒ 上面那条无主 INSERT 在当时是合法的
        expect(columnsOf(probe, "Conversation").find((c) => c.name === "userId")!.notnull).toBe(0);
      } finally {
        probe.close();
      }

      const failed = deployAll(fileUrl(target));
      expect(failed.ok, "B4 竟然 deploy 成功 —— §46 的 NOT NULL 防线失效").toBe(false);
      // 实测:真实 runner 报 P3018,底层约束落在重建目标表 new_Conversation 上
      expect(failed.output).toMatch(/P3018/);
      expect(failed.output).toMatch(/NOT NULL constraint failed: new_Conversation\.userId/);

      const after = openDatabase(target);
      try {
        // 原表完整、行数不变、无主行仍在原状态
        expect(objectSql(after, "Conversation")).toBe(tableSqlBefore);
        expect(rawCount(after, `SELECT COUNT(*) c FROM "Conversation"`)).toBe(rowsBefore);
        expect(
          rawCount(after, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`),
        ).toBe(1);
        // 无半迁移残留:重建临时表、新索引、触发器集合都停留在 deploy 之前
        expect(objectNames(after, "table")).not.toContain("new_Conversation");
        expect(objectNames(after, "index", "Conversation")).toEqual(indexesBefore);
        expect(objectNames(after, "trigger")).toEqual(TRIGGER_NAMES);
        // _prisma_migrations 只认前缀为已完成,B4 不得被记成已施加
        expect(appliedMigrations(after)).toEqual(appliedBefore);
        // 实测失败记录的形状:登记了这条迁移,但既没 finished 也没 rolled back
        expect(migrationRow(after, B4_MIGRATION)).toMatchObject({
          name: B4_MIGRATION,
          finishedAt: null,
          rolledBackAt: null,
          steps: 0,
        });
        // 库仍可正常检查外键(没有进入半损坏状态)
        expect(foreignKeyViolations(after)).toEqual([]);
        // 触发器行为依旧正确 ⇒ 结构没被半重建破坏
        assertTriggerBehaviour(after, COMPAT_USER_ID);
      } finally {
        after.close();
      }

      // 实测的恢复路径:runner 不会替你猜 —— 未 resolve 之前再 deploy 一律 P3009 拒绝
      const blocked = deployAll(fileUrl(target));
      expect(blocked.ok, "未 resolve 就又跑了一次 deploy").toBe(false);
      expect(blocked.output).toMatch(/P3009/);

      // 补上 owner ⇒ 官方 resolve ⇒ 同一个真实 runner 把链跑完(库结构从未被破坏)
      const fixer = openDatabase(target);
      try {
        fixer.exec(
          `UPDATE "Conversation" SET "userId" = '${ADMIN_USER_ID}' WHERE "userId" IS NULL`,
        );
      } finally {
        fixer.close();
      }
      const resolved = resolveRolledBack(B4_MIGRATION, fileUrl(target));
      expect(resolved.ok, resolved.output).toBe(true);
      const retry = deployAll(fileUrl(target));
      expect(retry.ok, retry.output).toBe(true);
      const done = openDatabase(target);
      try {
        // 完整性比较刻意与施加顺序无关:本用例的「前缀」= 除 B4 外的全部迁移,
        // 因此任何目录名晚于 B4 的新迁移都会在第一次 deploy 时先落地,B4 经 resolve 后最后补上。
        expect(appliedMigrations(done).slice().sort()).toEqual(ALL_MIGRATIONS);
        expect(
          rawCount(done, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`),
        ).toBe(0);
        expect(columnsOf(done, "Conversation").find((c) => c.name === "userId")!.notnull).toBe(1);
      } finally {
        done.close();
      }
    });
  },
);
