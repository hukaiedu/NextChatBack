/**
 * V1.4 U2:username 规则与归一化(design §5 / R3,任务书 §19-§20)。
 *
 * 唯一性的真相源是 DB 的 `UNIQUE(usernameNormalized)`(U1 migration),这里只负责把用户输入
 * 收敛成那个归一化形式 —— 归一化规则必须与唯一索引同源,否则 `Sky` / `SKY` 会注册成两个账号。
 * 本模块刻意不含 Prisma / Session / Express 依赖:规则要能被 controller 与 service 共同引用。
 */

/**
 * 字符集锁死为 ASCII:SQLite 的 `COLLATE NOCASE` 只对 ASCII 有效,非 ASCII 归一化(NFKC、
 * 同形字符)会引入无法用 DB 约束兜底的风险面(design §7 冻结)。
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

/**
 * 归一化 = ASCII 小写。字符集已锁为 ASCII,所以 `toLowerCase()` 与 locale 无关。
 *
 * 绝不能用 `toLocaleLowerCase()`:土耳其语 locale 下 `'I'` → `'ı'`(U+0131),
 * `"IQ"` 与 `"iq"` 会归一化成不同值,唯一约束形同失效 —— 而运行机器的 locale 不可控。
 */
export function normalizeUsername(value: string): string {
  return value.toLowerCase();
}
