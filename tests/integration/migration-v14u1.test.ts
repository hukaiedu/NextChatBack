import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_USER_ID } from "../../src/config/constants.js";
import { isUniqueViolation, uniqueViolationInfo } from "../../src/common/utils/prisma-error.js";
import { createPrismaClient } from "../../src/database/prisma.js";
import { columnsOf, foreignKeyViolations, objectSql, openDatabase, rawCount } from "../migration-harness.js";
import type { RawDb } from "../migration-harness.js";

/**
 * V1.4 U1:REGISTERED 凭据基础结构(user credential foundation)的 migration 验收。
 *
 * 红线(design §16,U1 任务书 §4/§14/§31):真实 `data/database/app.db` 全程只读。
 * 每一次写都落在 OS 临时目录里的副本或全新临时库上;原库只 read / copy。
 *
 * 取证顺序统一:真实 runner(`prisma migrate deploy`)→ 结构与数据守恒 → 行为。
 * 手工 exec 只出现在 MIG-05(需要注入失败语句,真实 runner 不提供该接缝)。
 */

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve("prisma/build/index.js");

const REPO = process.cwd();
const REAL_APP_DB = join(REPO, "data", "database", "app.db");
const SCHEMA = join(REPO, "prisma", "schema.prisma");
const MIGRATIONS_DIR = join(REPO, "prisma", "migrations");

const U1_MIGRATION = "20260914120000_v14_u1_user_credential";
/** V1.3 发布冻结点:U1 之前的最后一份 schema / generated client */
const BASE_REF = "7310f88a740343de4199b423d904e31eefd899f9";

/** 目录名升序即 Prisma 的施加顺序 */
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const PREFIX_MIGRATIONS = ALL_MIGRATIONS.filter((name) => name !== U1_MIGRATION);

const NEW_COLUMNS = ["username", "usernameNormalized", "passwordHash"];
const UNIQUE_INDEX = "User_usernameNormalized_key";
/** User 的列顺序:三个新列由 ADD COLUMN 追加在既有五列之后 */
const USER_COLUMN_ORDER = ["id", "type", "status", "createdAt", "updatedAt", ...NEW_COLUMNS];

function fileUrl(path: string): string {
  return `file:${path.replace(/\\/g, "/")}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface CliResult {
  ok: boolean;
  output: string;
}

function runPrisma(args: string[], env: Record<string, string>): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (caught) {
    const err = caught as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: [err.message, err.stdout, err.stderr].filter(Boolean).join("\n") };
  }
}

/** 仓库全量 migrations + prisma.config.ts;只通过 DATABASE_URL 换库 */
function deployAll(dbFile: string): CliResult {
  return runPrisma(["migrate", "deploy", "--schema", SCHEMA], { DATABASE_URL: fileUrl(dbFile) });
}

/**
 * 同一套真实 runner,但 migrations 目录只放指定前缀 —— 用于构造「U1 之前的库」。
 * `prisma.config.ts` 把 migrations.path 钉死在 prisma/migrations,--schema 改不动它,
 * 因此传一份独立 --config(绝对路径 + 纯对象)。
 */
function deployOnly(
  dbFile: string,
  names: string[],
  dir: string,
  tag: string,
): CliResult {
  const migrationsDir = join(dir, `${tag}-migrations`);
  mkdirSync(migrationsDir, { recursive: true });
  for (const name of names) {
    const to = join(migrationsDir, name);
    mkdirSync(to, { recursive: true });
    copyFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), join(to, "migration.sql"));
  }
  const url = fileUrl(dbFile);
  const configFile = join(dir, `${tag}.config.mjs`);
  writeFileSync(
    configFile,
    `export default ${JSON.stringify(
      { schema: SCHEMA, migrations: { path: migrationsDir }, datasource: { url } },
      null,
      2,
    )};\n`,
  );
  return runPrisma(["migrate", "deploy", "--config", configFile], {});
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

function indexNames(db: RawDb, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT "name" n FROM sqlite_master WHERE "type" = 'index' AND "tbl_name" = ?
           AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`,
      )
      .all(table) as { n: string }[]
  ).map((row) => row.n);
}

function triggerNames(db: RawDb): string[] {
  return (
    db
      .prepare(`SELECT "name" n FROM sqlite_master WHERE "type" = 'trigger' ORDER BY "name"`)
      .all() as { n: string }[]
  ).map((row) => row.n);
}

/** U1 之前的 User 快照:只取五个原字段,新增列不参与 */
function userSnapshot(db: RawDb): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT "id", "type", "status", CAST("createdAt" AS TEXT) "createdAt", CAST("updatedAt" AS TEXT) "updatedAt"
         FROM "User" ORDER BY "id"`,
    )
    .all() as Record<string, unknown>[];
}

const GUARDED_OBJECTS = [
  "Conversation",
  "Message",
  "ModelRequest",
  "Session",
  "Conversation_providerConversationUrl_key",
  "Conversation_status_idx",
  "Conversation_updatedAt_idx",
  "Conversation_userId_status_updatedAt_idx",
  "Message_conversationId_idx",
  "Message_conversationId_position_key",
  "ModelRequest_conversationId_idx",
  "ModelRequest_idempotencyKey_key",
  "ModelRequest_status_idx",
  "Session_expiresAt_idx",
  "Session_tokenHash_key",
  "Session_userId_idx",
  "uk_active_request_per_conversation",
  "trg_active_request_blocks_conversation_status_change",
  "trg_active_request_requires_active_conversation",
];

/** 除 User 之外的一切对象定义:U1 必须逐字节不触碰 */
function guardedObjects(db: RawDb): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of GUARDED_OBJECTS) {
    const row = db.prepare(`SELECT "sql" s FROM sqlite_master WHERE "name" = ?`).get(name) as
      | { s: string | null }
      | undefined;
    out[name] = row ? row.s?.replace(/\s+/g, " ").trim() ?? null : null;
  }
  return out;
}

function tableCounts(db: RawDb): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ["User", "Session", "Conversation", "Message", "ModelRequest"]) {
    counts[table] = rawCount(db, `SELECT COUNT(*) c FROM "${table}"`);
  }
  return counts;
}

function integrityOk(db: RawDb): string {
  return (db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string })
    .integrity_check;
}

/** 剔除注释 / 空行 / 事务包裹,按语句集合比较(顺序与空白无关) */
function sqlStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.replace(/\s+/g, " ").trim())
    .filter((stmt) => stmt.length > 0 && stmt !== "BEGIN" && stmt !== "COMMIT")
    .sort();
}

function assertCredentialSchema(db: RawDb): void {
  expect(columnsOf(db, "User").map((c) => c.name)).toEqual(USER_COLUMN_ORDER);
  for (const name of NEW_COLUMNS) {
    const col = columnsOf(db, "User").find((c) => c.name === name)!;
    expect({ name, notnull: col.notnull, dflt: col.dflt_value, pk: col.pk }).toEqual({
      name,
      notnull: 0,
      dflt: null,
      pk: 0,
    });
  }
  expect(indexNames(db, "User")).toContain(UNIQUE_INDEX);
  const indexSql = db.prepare(`SELECT "sql" s FROM sqlite_master WHERE "name" = ?`).get(
    UNIQUE_INDEX,
  ) as { s: string };
  expect(indexSql.s.replace(/\s+/g, " ")).toContain(
    `CREATE UNIQUE INDEX "${UNIQUE_INDEX}" ON "User"("usernameNormalized")`,
  );
}

describe("V1.4 U1 user credential migration", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "v14-u1-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // §34/§35:diff 面只含三列 + 一个 unique index;migration.sql 不含任何数据写入或破坏性语句
  it("U1-DIFF-01 prisma migrate diff 与手写 migration.sql 语句集合等价", () => {
    const headSchema = join(dir, "schema-head.prisma");
    writeFileSync(
      headSchema,
      execFileSync("git", ["show", `${BASE_REF}:prisma/schema.prisma`], {
        cwd: REPO,
        encoding: "utf8",
      }),
    );
    const diff = runPrisma(
      ["migrate", "diff", "--from-schema", headSchema, "--to-schema", SCHEMA, "--script"],
      {},
    );
    expect(diff.ok, diff.output).toBe(true);
    expect(sqlStatements(diff.output)).toEqual(
      sqlStatements(readFileSync(join(MIGRATIONS_DIR, U1_MIGRATION, "migration.sql"), "utf8")),
    );
  });

  it("U1-DIFF-02 migration.sql 只碰 User:三列 + 一索引,无破坏性语句", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, U1_MIGRATION, "migration.sql"), "utf8");
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const forbidden of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP INDEX",
      "DELETE FROM",
      "UPDATE ",
      "INSERT",
      "REINDEX",
      "VACUUM",
      "PRAGMA",
    ]) {
      expect(code.toUpperCase(), `migration.sql 不应出现 ${forbidden}`).not.toContain(forbidden);
    }
    expect((code.match(/ALTER TABLE/gi) ?? [])).toHaveLength(3);
    expect(code).not.toMatch(/ALTER TABLE "(?!User")/i);
    expect((code.match(/CREATE UNIQUE INDEX/gi) ?? [])).toHaveLength(1);
    expect(code.match(/BEGIN;|COMMIT;/g)).toEqual(["BEGIN;", "COMMIT;"]);
  });

  describe.skipIf(!existsSync(REAL_APP_DB))("MIG-01/02 真实 app.db 冷副本", () => {
    let target: string;
    let pristine: string;
    let sourceHashBefore: string;
    let sourceHashAfter: string;

    beforeAll(() => {
      target = join(dir, "app-copy.db");
      pristine = join(dir, "app-pristine.db");
      sourceHashBefore = sha256(REAL_APP_DB);
      copyFileSync(REAL_APP_DB, target);
      // 复制期间真实库可能被本机在跑的后端写入:再取一次 hash,两次相同才证明副本是一致的时点快照
      sourceHashAfter = sha256(REAL_APP_DB);
      copyFileSync(REAL_APP_DB, pristine);
    });

    it("MIG-01a 冷复制自证一致,且副本起点确实缺少 U1", () => {
      expect(sourceHashAfter).toBe(sourceHashBefore);
      expect(sha256(target)).toBe(sourceHashBefore);
      const before = openDatabase(target);
      try {
        expect(appliedMigrations(before).slice().sort()).toEqual(PREFIX_MIGRATIONS);
        expect(columnsOf(before, "User").map((c) => c.name)).not.toContain("username");
      } finally {
        before.close();
      }
    });

    it("MIG-01 真实 runner 只补 U1,结构与数据零漂移", () => {
      const before = openDatabase(pristine);
      let usersBefore: Record<string, unknown>[];
      let objectsBefore: Record<string, string | null>;
      let triggersBefore: string[];
      let countsBefore: Record<string, number>;
      let userDdlBefore: string;
      let appliedBefore: string[];
      try {
        usersBefore = userSnapshot(before);
        objectsBefore = guardedObjects(before);
        triggersBefore = triggerNames(before);
        countsBefore = tableCounts(before);
        userDdlBefore = objectSql(before, "User");
        appliedBefore = appliedMigrations(before);
      } finally {
        before.close();
      }

      const deployed = deployAll(target);
      expect(deployed.ok, deployed.output).toBe(true);

      const after = openDatabase(target);
      try {
        // §15:真实 runner 本次实际补上的 pending 恰好只有 U1 这一条(顺序无关比较)
        expect(appliedMigrations(after).slice().sort()).toEqual(ALL_MIGRATIONS);
        expect(appliedMigrations(after).filter((n) => !appliedBefore.includes(n))).toEqual([
          U1_MIGRATION,
        ]);

        assertCredentialSchema(after);
        const afterUserDdl = objectSql(after, "User");

        // MIG-02:既有 User 行(读实际数据,不写死行数)四字段原样,三列全 NULL
        expect(userSnapshot(after)).toEqual(usersBefore);
        expect(
          rawCount(
            after,
            `SELECT COUNT(*) c FROM "User"
              WHERE "username" IS NOT NULL OR "usernameNormalized" IS NOT NULL OR "passwordHash" IS NOT NULL`,
          ),
        ).toBe(0);
        expect(rawCount(after, `SELECT COUNT(*) c FROM "User" WHERE "type" = 'REGISTERED'`)).toBe(0);
        // §6/§17:U1 不给固定 ADMIN / COMPAT 造凭据
        for (const id of ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"]) {
          expect(
            rawCount(
              after,
              `SELECT COUNT(*) c FROM "User" WHERE "id" = '${id}'
                 AND "username" IS NULL AND "usernameNormalized" IS NULL AND "passwordHash" IS NULL`,
            ),
          ).toBe(1);
        }

        // 其余对象逐字节不变;User 原定义只被追加列、未被改写
        expect(afterUserDdl.startsWith(userDdlBefore.slice(0, userDdlBefore.lastIndexOf(")")))).toBe(
          true,
        );
        expect(afterUserDdl).toContain(`CHECK ("type" IN ('ANONYMOUS', 'REGISTERED', 'ADMIN'))`);
        expect(afterUserDdl).toContain(`CHECK ("status" IN ('ACTIVE', 'DISABLED'))`);
        expect(guardedObjects(after)).toEqual(objectsBefore);
        expect(triggerNames(after)).toEqual(triggersBefore);
        expect(tableCounts(after)).toEqual(countsBefore);
        expect(foreignKeyViolations(after)).toEqual([]);
        expect(integrityOk(after)).toBe("ok");
      } finally {
        after.close();
      }
    });

    // §16:真实库比 V1.3 更旧时,同一条链必须整串补齐 —— 这是生产部署路径的证明
    it("MIG-01b 停在 m1 的库由真实 runner 顺序补齐 I1→B1→B4→U1", () => {
      const legacy = join(dir, "legacy.db");
      const legacyPrefix = ALL_MIGRATIONS.slice(0, 3);
      const seeded = deployOnly(legacy, legacyPrefix, dir, "legacy");
      expect(seeded.ok, seeded.output).toBe(true);

      const probe = openDatabase(legacy);
      try {
        expect(appliedMigrations(probe)).toEqual(legacyPrefix);
        probe.exec(
          `INSERT INTO "Conversation" ("id","title","status","createdAt","updatedAt")
           VALUES ('legacy-1','历史会话','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:01:00')`,
        );
      } finally {
        probe.close();
      }

      const deployed = deployAll(legacy);
      expect(deployed.ok, deployed.output).toBe(true);

      const after = openDatabase(legacy);
      try {
        expect(appliedMigrations(after)).toEqual(ALL_MIGRATIONS);
        assertCredentialSchema(after);
        expect(
          rawCount(after, `SELECT COUNT(*) c FROM "Conversation" WHERE "id" = 'legacy-1'`),
        ).toBe(1);
        // B1 回填 + B4 收紧:历史会话归固定 ADMIN,而不是随便某个 User
        expect(
          after.prepare(`SELECT "userId" u FROM "Conversation" WHERE "id" = 'legacy-1'`).get(),
        ).toEqual({ u: ADMIN_USER_ID });
        expect(integrityOk(after)).toBe("ok");
      } finally {
        after.close();
      }
    });
  });

  describe("MIG-03 multiple NULL coexist", () => {
    let dbFile: string;

    beforeAll(() => {
      dbFile = join(dir, "multi-null.db");
      const deployed = deployAll(dbFile);
      expect(deployed.ok, deployed.output).toBe(true);
    });

    it("多条 usernameNormalized=NULL 的匿名/管理员行可共存", () => {
      const db = openDatabase(dbFile);
      try {
        expect(indexNames(db, "User")).toContain(UNIQUE_INDEX);
        // 固定哨兵行由 B1 迁移建立,type 不同但归一化列同为 NULL ⇒ 先确认它们本就存在
        expect(
          rawCount(
            db,
            `SELECT COUNT(*) c FROM "User"
              WHERE "id" IN ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002')
                AND "usernameNormalized" IS NULL`,
          ),
        ).toBe(2);
        db.exec(
          `INSERT INTO "User" ("id","type","status","createdAt","updatedAt")
           VALUES ('u-null-1','ANONYMOUS','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00'),
                  ('u-null-2','ANONYMOUS','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00'),
                  ('u-null-3','ANONYMOUS','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00'),
                  ('u-null-4','ADMIN','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00'),
                  ('u-null-5','REGISTERED','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
        );
        // 五条新插入 + 两个哨兵 = 7 行归一化列为 NULL,唯一索引完全不参与 NULL 比较
        expect(
          rawCount(db, `SELECT COUNT(*) c FROM "User" WHERE "usernameNormalized" IS NULL`),
        ).toBe(7);
        expect(integrityOk(db)).toBe("ok");
      } finally {
        db.close();
      }
    });

    it("匿名 bootstrap 的 Prisma 写入形状在 U1 之后照常工作", async () => {
      const prisma = await createPrismaClient(fileUrl(dbFile));
      try {
        // 与 AuthUserRepository.createAnonymous 同形状(U1 不改 auth 代码,这里只在 DB 层验证)
        const first = await prisma.user.create({ data: { type: "ANONYMOUS", status: "ACTIVE" } });
        const second = await prisma.user.create({ data: { type: "ANONYMOUS", status: "ACTIVE" } });
        expect(first.id).not.toBe(second.id);
        for (const user of [first, second]) {
          expect(user.username).toBeNull();
          expect(user.usernameNormalized).toBeNull();
          expect(user.passwordHash).toBeNull();
        }
      } finally {
        await prisma.$disconnect();
      }
    });
  });

  describe("MIG-06 unique constraint + structured P2002", () => {
    let dbFile: string;

    beforeAll(() => {
      dbFile = join(dir, "unique.db");
      const deployed = deployAll(dbFile);
      expect(deployed.ok, deployed.output).toBe(true);
    });

    it("同名第二次写入被拒,P2002 的结构化 fields 含 usernameNormalized", async () => {
      const prisma = await createPrismaClient(fileUrl(dbFile));
      const credential = (username: string, normalized: string, hash: string) => ({
        type: "REGISTERED",
        username,
        usernameNormalized: normalized,
        passwordHash: hash,
      });
      try {
        await prisma.user.create({ data: credential("alice", "alice", "hash-a") });
        let caught: unknown;
        try {
          await prisma.user.create({ data: credential("alice-second", "alice", "hash-b") });
        } catch (err) {
          caught = err;
        }
        expect(caught, "重复 usernameNormalized 竟然写入成功 ⇒ 唯一索引失效").toBeTruthy();
        expect(isUniqueViolation(caught)).toBe(true);
        const info = uniqueViolationInfo(caught);
        expect(info.fields).toContain("usernameNormalized");
        expect(info.modelName).toBe("User");
        // §21:判定只认结构化字段,绝不解析 error.message、绝不按索引名分类
      } finally {
        await prisma.$disconnect();
      }
    });

    it("raw SQL 同样被拒 ⇒ 约束落在 DB 层而非 Prisma 层", () => {
      const db = openDatabase(dbFile);
      try {
        expect(() =>
          db.exec(
            `INSERT INTO "User" ("id","type","status","username","usernameNormalized","passwordHash","createdAt","updatedAt")
             VALUES ('dup-1','REGISTERED','ACTIVE','alice','alice','z','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
          ),
        ).toThrow(/UNIQUE constraint failed: User\.usernameNormalized/);
      } finally {
        db.close();
      }
    });

    it("唯一性只在归一化列:展示值可重复,大小写变体由 U2 归一化收敛", () => {
      const db = openDatabase(dbFile);
      const insert = (id: string, username: string, normalized: string) =>
        db.exec(
          `INSERT INTO "User" ("id","type","status","username","usernameNormalized","passwordHash","createdAt","updatedAt")
           VALUES ('${id}','REGISTERED','ACTIVE','${username}','${normalized}','h','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
        );
      try {
        insert("u-display-1", "bob", "bob-display");
        insert("u-display-2", "bob", "bob-other");
        insert("u-case-1", "Sky", "sky");
        // DB 层不做 COLLATE NOCASE(§22):Sky / SKY 归一化后同值才冲突
        expect(() => insert("u-case-2", "SKY", "sky")).toThrow(/UNIQUE constraint failed/);
        expect(rawCount(db, `SELECT COUNT(*) c FROM "User" WHERE "usernameNormalized" = 'sky'`)).toBe(1);
        expect(rawCount(db, `SELECT COUNT(*) c FROM "User" WHERE "username" = 'bob'`)).toBe(2);
      } finally {
        db.close();
      }
    });
  });

  describe("MIG-05 migration atomicity", () => {
    let dbFile: string;

    beforeAll(() => {
      dbFile = join(dir, "atomicity.db");
      const seeded = deployOnly(dbFile, PREFIX_MIGRATIONS, dir, "atomicity");
      expect(seeded.ok, seeded.output).toBe(true);
      const db = openDatabase(dbFile);
      try {
        expect(appliedMigrations(db)).toEqual(PREFIX_MIGRATIONS);
        db.exec(
          `INSERT INTO "User" ("id","type","status","createdAt","updatedAt")
           VALUES ('u-pre-1','ANONYMOUS','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:01:00')`,
        );
      } finally {
        db.close();
      }
    });

    /** 与正式 U1 文件同形,但最后一句故意失败 */
    function failingVariant(failure: string): string {
      return [
        "BEGIN;",
        `ALTER TABLE "User" ADD COLUMN "username" TEXT;`,
        `ALTER TABLE "User" ADD COLUMN "usernameNormalized" TEXT;`,
        `ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;`,
        `CREATE UNIQUE INDEX "${UNIQUE_INDEX}" ON "User"("usernameNormalized");`,
        failure,
        "COMMIT;",
      ].join("\n");
    }

    const cases = [
      ["索引引用不存在的列", `CREATE INDEX "bad_idx" ON "User"("no_such_column");`],
      [
        "违反 CHECK 的数据写入",
        `INSERT INTO "User" ("id","type","status","createdAt","updatedAt") VALUES ('u-bad','ROBOT','ACTIVE','2026-01-01 00:00:00','2026-01-01 00:00:00');`,
      ],
    ] as const;

    for (const [label, failure] of cases) {
      it(`失败语句(${label})整事务回滚,不留半套 credential schema`, () => {
        const db = openDatabase(dbFile);
        const ddlBefore = objectSql(db, "User");
        const objectsBefore = guardedObjects(db);
        const usersBefore = rawCount(db, `SELECT COUNT(*) c FROM "User"`);
        expect(columnsOf(db, "User").map((c) => c.name)).not.toContain("username");
        try {
          expect(() => db.exec(failingVariant(failure))).toThrow();
        } finally {
          db.close();
        }

        const after = openDatabase(dbFile);
        try {
          const names = columnsOf(after, "User").map((c) => c.name);
          for (const col of NEW_COLUMNS) expect(names).not.toContain(col);
          expect(indexNames(after, "User")).not.toContain(UNIQUE_INDEX);
          expect(indexNames(after, "User")).not.toContain("bad_idx");
          expect(objectSql(after, "User")).toBe(ddlBefore);
          expect(guardedObjects(after)).toEqual(objectsBefore);
          expect(rawCount(after, `SELECT COUNT(*) c FROM "User"`)).toBe(usersBefore);
          expect(integrityOk(after)).toBe("ok");
        } finally {
          after.close();
        }
      });
    }

    it("回滚后的库仍可正常施加真正的 U1", () => {
      const deployed = deployAll(dbFile);
      expect(deployed.ok, deployed.output).toBe(true);
      const db = openDatabase(dbFile);
      try {
        expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS);
        assertCredentialSchema(db);
        expect(
          rawCount(
            db,
            `SELECT COUNT(*) c FROM "User" WHERE "id" = 'u-pre-1' AND "usernameNormalized" IS NULL`,
          ),
        ).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  describe("MIG-04 old client forward compatibility", () => {
    let dbFile: string;
    let oldClientDir: string;

    beforeAll(() => {
      dbFile = join(dir, "old-client.db");
      const deployed = deployAll(dbFile);
      expect(deployed.ok, deployed.output).toBe(true);

      // 取 BASE_REF 那份 tracked generated client,落到 gitignored 的 data/debug 下(能被 Vite 转译)
      oldClientDir = join(REPO, "data", "debug", `v14u1-old-client-${process.pid}`);
      const files = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", BASE_REF, "src/generated/prisma"],
        { cwd: REPO, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
      expect(files.length).toBeGreaterThan(0);
      for (const rel of files) {
        const content = execFileSync("git", ["show", `${BASE_REF}:${rel}`], {
          cwd: REPO,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        const dest = join(oldClientDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        // 生成物用 .js 说明符指向 .ts 源(打包器约定);按源文件直接加载时改回扩展名
        writeFileSync(dest, content.replace(/(from "\.\.?\/[^"]*)\.js"/g, '$1.ts"'));
      }
      expect(
        readFileSync(join(oldClientDir, "src/generated/prisma/models/User.ts"), "utf8"),
      ).not.toContain("usernameNormalized");
    });

    afterAll(() => {
      rmSync(oldClientDir, { recursive: true, force: true });
    });

    it("旧 client 读 User/Conversation 不报错、字段集合不感知新列,且能照常写入", async () => {
      const clientModule = (await import(
        pathToFileURL(join(oldClientDir, "src/generated/prisma/client.ts")).href
      )) as { PrismaClient: new (options: unknown) => OldClient };
      const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3") as {
        PrismaBetterSqlite3: new (options: { url: string }) => unknown;
      };

      const old = new clientModule.PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: fileUrl(dbFile) }),
      });
      let createdUserId = "";
      try {
        const users = await old.user.findMany();
        expect(users.length).toBeGreaterThan(0);
        for (const user of users) {
          // 旧 client 的字段集合里没有新列 ⇒ 库里多出来的 nullable 列被安全忽略
          expect(Object.keys(user).sort()).toEqual([
            "createdAt",
            "id",
            "status",
            "type",
            "updatedAt",
          ]);
        }
        expect(Array.isArray(await old.conversation.findMany({ take: 5 }))).toBe(true);

        // V1.3 允许的三类写入:匿名 User / Session / Conversation
        const created = await old.user.create({ data: { type: "ANONYMOUS", status: "ACTIVE" } });
        createdUserId = String(created.id);
        await old.session.create({
          data: {
            userId: createdUserId,
            tokenHash: "0".repeat(64),
            expiresAt: new Date(Date.now() + 60_000),
            lastSeenAt: new Date(),
          },
        });
        await old.conversation.create({
          data: { userId: createdUserId, title: "旧版本写入的会话" },
        });
      } finally {
        await old.$disconnect();
      }

      // DB 侧复核(不靠旧 client 的返回值):新写入的三列确实是 NULL
      const db = openDatabase(dbFile);
      try {
        expect(
          rawCount(
            db,
            `SELECT COUNT(*) c FROM "User" WHERE "id" = '${createdUserId}'
               AND "username" IS NULL AND "usernameNormalized" IS NULL AND "passwordHash" IS NULL`,
          ),
        ).toBe(1);
        expect(
          rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "title" = '旧版本写入的会话'`),
        ).toBe(1);
        expect(rawCount(db, `SELECT COUNT(*) c FROM "Session" WHERE "userId" = '${createdUserId}'`)).toBe(1);
        expect(integrityOk(db)).toBe("ok");
      } finally {
        db.close();
      }
    });
  });
});

/** V1.3 冻结点那份 generated client 在本测试里用到的最小形状 */
interface OldClient {
  user: {
    findMany(args?: unknown): Promise<Record<string, unknown>[]>;
    create(args: unknown): Promise<Record<string, unknown>>;
  };
  conversation: {
    findMany(args?: unknown): Promise<Record<string, unknown>[]>;
    create(args: unknown): Promise<Record<string, unknown>>;
  };
  session: { create(args: unknown): Promise<Record<string, unknown>> };
  $disconnect(): Promise<void>;
}
