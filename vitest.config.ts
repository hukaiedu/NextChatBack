import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 所有测试文件共享同一个 SQLite 测试库,串行执行避免互相干扰
    fileParallelism: false,
    globalSetup: ["./tests/global-setup.ts"],
  },
});
