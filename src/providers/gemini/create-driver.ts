import type { Env } from "../../config/env.js";
import { PlaywrightBrowserDriver } from "./playwright-driver.js";

/**
 * P8-PROXY-03:main 与 provisioning CLI 共享的 driver 工厂。
 * 两个入口都经这里获得 proxy wiring,禁止各自 new PlaywrightBrowserDriver
 * (结构约束,见设计文档 Revision 3.1 §33 / 实现报告 P8-PROXY-03)。
 */
export function createDriver(env: Pick<Env, "BROWSER_PROXY_URL">): PlaywrightBrowserDriver {
  return new PlaywrightBrowserDriver({
    proxyUrl: env.BROWSER_PROXY_URL,
  });
}
