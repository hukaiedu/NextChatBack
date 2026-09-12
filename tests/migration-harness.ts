import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Migration 专项测试共用的临时库工装。
 *
 * 所有 migration 测试都要在「历史基线 → 手工插数据 → 重放目标 migration」的顺序上取证,
 * 而 global-setup 的 migrate deploy 只能一次性建到最新,无法内插历史数据。
 * 这里开的库都在系统临时目录,**绝不触碰 data/database 下的业务库或测试库**。
 */

export interface RawSqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqlStatement;
  pragma(source: string, options?: { simple: boolean }): unknown;
  close(): void;
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (file: string) => RawDb;

export function migrationSql(name: string): string {
  return readFileSync(join(process.cwd(), "prisma", "migrations", name, "migration.sql"), "utf8");
}

/**
 * 打开指定库文件(调用方负责 close 与清理)。
 * 需要把路径交给外部 CLI(如 `prisma migrate deploy`)的演练无法用 withFreshDb 的匿名临时库。
 */
export function openDatabase(file: string): RawDb {
  return new Database(file);
}

/** 依次重放一组 migration,然后执行 fn */
export function replayMigrations(db: RawDb, names: string[]): void {
  for (const name of names) {
    db.exec(migrationSql(name));
  }
}

export function withFreshDb<T>(fn: (db: RawDb) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "migration-harness-"));
  const db = openDatabase(join(dir, "probe.db"));
  try {
    db.pragma("foreign_keys = ON"); // 与生产 createPrismaClient 的显式设置一致
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function rawCount(db: RawDb, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** 列定义签名(名、顺序、类型、NOT NULL、默认值、是否 PK) */
export function columnsOf(db: RawDb, table: string): ColumnInfo[] {
  return db
    .prepare(
      `SELECT "name", "type", "notnull", "dflt_value", "pk" FROM pragma_table_info('${table}') ORDER BY "cid"`,
    )
    .all() as ColumnInfo[];
}

export interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
  on_update: string;
}

export function foreignKeysOf(db: RawDb, table: string): ForeignKeyInfo[] {
  return db
    .prepare(
      `SELECT "table", "from", "to", "on_delete", "on_update" FROM pragma_foreign_key_list('${table}')`,
    )
    .all() as ForeignKeyInfo[];
}

/** sqlite_master 里的对象定义文本(索引 / 触发器),用于逐字节比较是否被重建改写 */
export function objectSql(db: RawDb, name: string): string {
  const row = db.prepare(`SELECT "sql" FROM sqlite_master WHERE "name" = ?`).get(name) as
    | { sql: string | null }
    | undefined;
  if (!row || row.sql === null) {
    throw new Error(`sqlite object '${name}' is missing`);
  }
  return row.sql.replace(/\s+/g, " ").trim();
}

/** 违反 §40 红线时必须为空的检查 */
export function foreignKeyViolations(db: RawDb): unknown[] {
  return db.prepare(`PRAGMA foreign_key_check`).all();
}

/**
 * 触发器行为夹具:造一对 USER / ASSISTANT 消息(basePosition 用于避开
 * `Message(conversationId, position)` 唯一约束)。任何库都能用 —— 临时库重放与真实
 * `migrate deploy` 演练都要跑同一组 TRG-01/01N/02/02N。
 */
export function insertMessagePair(
  db: RawDb,
  conversationId: string,
  suffix: string,
  basePosition = 1,
): { userMessageId: string; assistantMessageId: string } {
  const userMessageId = `${conversationId}-u-${suffix}`;
  const assistantMessageId = `${conversationId}-a-${suffix}`;
  db.exec(
    `INSERT INTO "Message" ("id","conversationId","role","content","status","position","createdAt","updatedAt")
     VALUES ('${userMessageId}','${conversationId}','USER','你好','COMPLETED',${basePosition},'2026-01-01 00:00:00','2026-01-01 00:00:00'),
             ('${assistantMessageId}','${conversationId}','ASSISTANT','回答','COMPLETED',${basePosition + 1},'2026-01-01 00:00:00','2026-01-01 00:00:00')`,
  );
  return { userMessageId, assistantMessageId };
}

/** 造一条指定状态的 Request(id 同时充当 idempotencyKey,保持唯一) */
export function insertRequest(
  db: RawDb,
  opts: {
    id: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    status: string;
  },
): void {
  db.exec(
    `INSERT INTO "ModelRequest"
       ("id","conversationId","userMessageId","assistantMessageId","idempotencyKey",
        "requestFingerprint","status","updatedAt")
     VALUES ('${opts.id}','${opts.conversationId}','${opts.userMessageId}','${opts.assistantMessageId}',
             '${opts.id}','fp-${opts.id}','${opts.status}','2026-01-01 00:00:00')`,
  );
}
