import { describe, expect, it } from "vitest";

import { isUniqueViolation, uniqueViolationInfo } from "../../src/common/utils/prisma-error.js";

/**
 * I1.1:P2002 唯一约束信息解析(纯形状层)。
 *
 * 真实形状来自本机取证(Prisma 7 + @prisma/adapter-better-sqlite3):
 *   meta = { modelName, driverAdapterError: { cause: { originalCode, kind, table, constraint: { fields } } } }
 *   —— **没有 meta.target,也永远不报索引名**。
 * 这里只锁「怎么解析」;「真撞约束」由 tests/integration/request-race.test.ts 用真 SQLite 证。
 */

/** 当前 driver adapter 的 P2002 */
function adapterError(input: {
  modelName?: unknown;
  table?: unknown;
  fields?: unknown;
  kind?: unknown;
}): unknown {
  return {
    name: "PrismaClientKnownRequestError",
    code: "P2002",
    clientVersion: "test",
    meta: {
      modelName: input.modelName ?? "ModelRequest",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "SQLITE_CONSTRAINT_UNIQUE",
          originalMessage: "UNIQUE constraint failed: <Table>.<columns>",
          kind: input.kind ?? "UniqueConstraintViolation",
          constraint: { fields: input.fields },
          table: input.table ?? "ModelRequest",
        },
      },
    },
  };
}

describe("uniqueViolationInfo —— 旧 query-engine 形状(必须继续可用)", () => {
  it("P2X-01 meta.target 是数组 → 归一成 fields", () => {
    const err = { code: "P2002", meta: { target: ["idempotencyKey"], modelName: "ModelRequest" } };
    expect(uniqueViolationInfo(err)).toEqual({
      modelName: "ModelRequest",
      fields: ["idempotencyKey"],
    });
  });

  it("P2X-02 meta.target 是字符串 → 不抛,单元素 fields", () => {
    expect(uniqueViolationInfo({ code: "P2002", meta: { target: "idempotencyKey" } }).fields).toEqual([
      "idempotencyKey",
    ]);
  });

  it("P2X-02B target 数组里有非字符串 → 统一转字符串,不抛", () => {
    expect(uniqueViolationInfo({ code: "P2002", meta: { target: [1, "position"] } }).fields).toEqual([
      "1",
      "position",
    ]);
  });

  it("P2X-02C target 优先:两种形状同时在场时不读 adapter 分支", () => {
    const err = adapterError({ fields: ["conversationId"] });
    (err as { meta: Record<string, unknown> }).meta.target = ["idempotencyKey"];
    expect(uniqueViolationInfo(err).fields).toEqual(["idempotencyKey"]);
  });
});

describe("uniqueViolationInfo —— 当前 driver adapter 形状", () => {
  it("P2X-03 单列 conversationId + modelName/table 都取到(活动 Request 部分索引的真实形状)", () => {
    expect(
      uniqueViolationInfo(
        adapterError({ modelName: "ModelRequest", table: "ModelRequest", fields: ["conversationId"] }),
      ),
    ).toEqual({ modelName: "ModelRequest", table: "ModelRequest", fields: ["conversationId"] });
  });

  it("P2X-04 复合唯一 → 两列都在且顺序不变", () => {
    expect(
      uniqueViolationInfo(
        adapterError({ modelName: "Message", table: "Message", fields: ["conversationId", "position"] }),
      ).fields,
    ).toEqual(["conversationId", "position"]);
  });

  it("P2X-04B 只有 cause.table、无 modelName 时仍能定位归属", () => {
    expect(
      uniqueViolationInfo(
        adapterError({ modelName: undefined, table: "Conversation", fields: ["providerConversationUrl"] }),
      ),
    ).toMatchObject({ table: "Conversation", fields: ["providerConversationUrl"] });
  });
});

describe("uniqueViolationInfo —— 认不出就不给结论", () => {
  it("P2X-05 meta 缺失 / 为空 → fields 空", () => {
    expect(uniqueViolationInfo({ code: "P2002" })).toEqual({ fields: [] });
    expect(uniqueViolationInfo({ code: "P2002", meta: {} }).fields).toEqual([]);
    expect(uniqueViolationInfo({ code: "P2002", meta: { modelName: "ModelRequest" } }).fields).toEqual([]);
  });

  it("P2X-06 深层每一层类型错都只返回空,绝不抛", () => {
    const cases: unknown[] = [
      { code: "P2002", meta: { driverAdapterError: "boom" } },
      { code: "P2002", meta: { driverAdapterError: { cause: 42 } } },
      { code: "P2002", meta: { driverAdapterError: { cause: { constraint: "none" } } } },
      { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: 7 } } } } },
      { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: {} } } } } },
      { code: "P2002", meta: { driverAdapterError: null } },
      { code: "P2002", meta: null },
      null,
      undefined,
      "P2002",
    ];
    for (const value of cases) {
      expect(() => uniqueViolationInfo(value)).not.toThrow();
      expect(uniqueViolationInfo(value).fields).toEqual([]);
    }
  });

  it("P2X-07 只允许读结构化字段:文案里写着 UNIQUE 也不算冲突列", () => {
    const err = {
      code: "P2002",
      message: "Unique constraint failed on the fields: (`conversationId`)",
      meta: {},
    };
    expect(uniqueViolationInfo(err).fields).toEqual([]);
    const withText = adapterError({ fields: undefined });
    (withText as { message?: string }).message = "UNIQUE constraint failed: ModelRequest.conversationId";
    expect(uniqueViolationInfo(withText).fields).toEqual([]);
  });

  it("P2X-08 P2003(trigger 中止)不是唯一约束冲突:两件事都判否", () => {
    const p2003 = {
      name: "PrismaClientKnownRequestError",
      code: "P2003",
      meta: {
        modelName: "Conversation",
        driverAdapterError: {
          cause: {
            originalCode: "SQLITE_CONSTRAINT_TRIGGER",
            kind: "ForeignKeyConstraintViolation",
            constraint: { foreignKey: "model_request_active_requires_active_conversation" },
          },
        },
      },
    };
    expect(isUniqueViolation(p2003)).toBe(false);
    expect(uniqueViolationInfo(p2003).fields).toEqual([]);
  });

  it("P2X-09 非唯一约束的其他 code 一律空(不因见到 meta 就笼统归类)", () => {
    const err = adapterError({ fields: ["conversationId"] });
    (err as { code: string }).code = "P2000";
    expect(uniqueViolationInfo(err).fields).toEqual([]);
  });
});
