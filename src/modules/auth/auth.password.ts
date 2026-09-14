import { Algorithm, hash, verify } from "@node-rs/argon2";

import { Argon2CapacityGate } from "./auth.argon2-capacity.js";

/**
 * V1.4 U2:口令散列与策略(design §6 / R5,任务书 §15-§18)。
 *
 * 职责边界:只碰口令本身 —— 不依赖 Prisma / Session / Express。
 * 「用户是否存在」「状态是否 ACTIVE」这类判断属 service,混进来会让这两条路径的
 * CPU 形状无法统一(见下 DUMMY_PASSWORD_HASH 的理由)。
 */

/** 长度政策;不做字符类别强制(不与口令管理器对抗),不做字典检查(design §6) */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 冻结参数(design §6:OWASP Argon2id 下限)。包自身默认值恰好等于这组,
 * 但仍显式写出 —— 依赖升级改默认值时,新注册的口令强度不能悄悄变化。
 * PHC 串内嵌算法与参数,因此日后提参无需数据迁移。
 */
export const ARGON2_MEMORY_COST = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_OUTPUT_LEN = 32;

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
  outputLen: ARGON2_OUTPUT_LEN,
} as const;

export interface RawPasswordCrypto {
  hash(password: string): Promise<string>;
  verify(hashed: string, password: string): Promise<boolean>;
}

export interface PasswordCrypto {
  hashPassword(password: string): Promise<string>;
  verifyPassword(hashed: string, password: string): Promise<boolean>;
}

/**
 * 用户名不存在时也执行一次同等成本的 verify,缩小「查无此人」与「密码错误」的 CPU 时间差
 * (design §6)。这只降低信号强度,不声称 constant-time。
 *
 * 它不是 secret:对一次性随机值生成、永不与任何真实口令配对,可以普通源码常量提交。
 * 绝不要在请求里现生成 —— 那会让每条未知用户名的请求付双倍散列成本。
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$Pgl6ECXcP0IyrXiT4fclQQ$8JZBkcdDrwRGbCTXCHPoT23f4bgU6NKYwfxq11/lc8I";

const rawPasswordCrypto: RawPasswordCrypto = {
  hash: (password) => hash(password, ARGON2_OPTIONS),
  verify: (hashed, password) => verify(hashed, password),
};

/** Production auth paths use this app-runtime-scoped gated facade. */
export function createPasswordCrypto(
  gate: Argon2CapacityGate,
  raw: RawPasswordCrypto = rawPasswordCrypto,
): PasswordCrypto {
  return {
    hashPassword: (password) => gate.run(() => raw.hash(password)),
    verifyPassword: (hashed, password) =>
      gate.run(async () => {
        try {
          return await raw.verify(hashed, password);
        } catch {
          return false;
        }
      }),
  };
}

/** async-only:散列是 CPU 昂贵操作,请求路径上绝不用 hashSync/verifySync */
export function hashPassword(password: string): Promise<string> {
  return rawPasswordCrypto.hash(password);
}

/**
 * 统一给出布尔结论:库对畸形摘要串抛异常,而调用方需要的是「这组凭据不成立」。
 * 库里出现畸形 hash 属数据异常,但它在 Public 面与「密码错误」同码(`AUTH_INVALID_CREDENTIALS`),
 * 因此这里不区分出口 —— 区分本身就是新的枚举面。
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await rawPasswordCrypto.verify(hashed, password);
  } catch {
    return false;
  }
}
