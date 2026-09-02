import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

export const TEST_DATABASE_URL = "file:./data/database/test.db";

/**
 * 测试全局准备:
 * 1. 删除旧测试库
 * 2. 用真实 migration(migrate deploy)重建测试库 schema
 */
export default function setup(): void {
  rmSync("./data/database/test.db", { force: true });

  execSync("yarn prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
    },
  });
}
