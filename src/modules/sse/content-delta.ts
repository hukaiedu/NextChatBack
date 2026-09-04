/**
 * 一次内容更新的两种形态(第 6 阶段 §5)。
 *
 * - `delta`:当前文本以已发文本为前缀,只补后缀;
 * - `snapshot`:前文被改写(不再是前缀),必须整段覆盖,禁止拼出错误文本。
 */
export type ContentUpdate =
  | { type: "delta"; content: string }
  | { type: "snapshot"; content: string };

/**
 * 由「本连接已发出的文本」与「当前完整文本」推导更新。
 *
 * 计算放在消费端而不是生产端:同一 Request 可以有多个订阅者,各自加入时刻不同,
 * 只有按连接自身的前缀推导,晚加入 / 断线重连的连接才不会收到缺前缀的 delta。
 */
export function computeContentUpdate(previous: string, current: string): ContentUpdate {
  if (current.startsWith(previous)) {
    return { type: "delta", content: current.slice(previous.length) };
  }
  return { type: "snapshot", content: current };
}
