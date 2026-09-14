import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { prepareSafeMigrationDb } from "./migration-harness.js";

export const TEST_DATABASE_URL = "file:./data/database/test.db";
const TEST_DATABASE_FILE = resolve("data/database/test.db");

/**
 * 测试全局准备:
 * 1. 删除旧测试库
 * 2. 用真实 migration(migrate deploy)重建测试库 schema
 */
export default function setup(): void {
  const databaseUrl = prepareSafeMigrationDb(TEST_DATABASE_FILE);

  execSync("yarn prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });
}
