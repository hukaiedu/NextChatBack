import type { PrismaClient } from "../../generated/prisma/client.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { BrowserProviderStatus } from "../../providers/gemini/browser-driver.js";
import { REQUEST_ACTIVE_STATUSES } from "../request/request.types.js";

export type BrowserState = "RUNNING" | "STARTING" | "RESTARTING" | "STOPPED" | "FAILED";

export interface BrowserStatusSnapshot {
  state: BrowserState;
  provider: string;
  browserType: string;
  headless: boolean;
  profileDir: string;
  startedAt: string | null;
  uptimeMs: number | null;
  providerLoggedIn: boolean | null;
  activeRequests: number;
  lastError: { code: string; message: string } | null;
  observedAt: string;
}

/**
 * 浏览器状态快照(docs/browser-status-api.md):
 * 把 BrowserManager 内部状态机映射为面向前端的粗粒度 state,并附上
 * Profile / 启动时间 / 登录态 / 在飞 Request 数等展示字段。只读,无副作用。
 */
export class BrowserStatusService {
  constructor(
    private readonly browserManager: BrowserManager,
    private readonly prisma: PrismaClient,
  ) {}

  async getSnapshot(): Promise<BrowserStatusSnapshot> {
    const providerStatus = this.browserManager.getStatus();
    const startedAt = this.browserManager.getStartedAt();
    return {
      state: this.browserManager.isRestarting()
        ? "RESTARTING"
        : mapBrowserState(providerStatus),
      provider: this.browserManager.getProviderName(),
      browserType: "chromium",
      headless: this.browserManager.isHeadless(),
      profileDir: this.browserManager.getProfileDir(),
      startedAt: startedAt?.toISOString() ?? null,
      uptimeMs: startedAt === null ? null : Date.now() - startedAt.getTime(),
      providerLoggedIn:
        providerStatus === "READY"
          ? true
          : providerStatus === "LOGIN_REQUIRED"
            ? false
            : null,
      activeRequests: await this.countActiveRequests(),
      lastError: this.browserManager.getLastBrowserError(),
      observedAt: new Date().toISOString(),
    };
  }

  async countActiveRequests(): Promise<number> {
    return this.prisma.modelRequest.count({
      where: { status: { in: [...REQUEST_ACTIVE_STATUSES] } },
    });
  }
}

/**
 * READY/BUSY/LOGIN_REQUIRED 对前端都是「进程活着」(登录态单独看 providerLoggedIn);
 * STARTING 是启动中;ERROR 是失败;STOPPED 兜底。
 */
function mapBrowserState(status: BrowserProviderStatus): Exclude<BrowserState, "RESTARTING"> {
  switch (status) {
    case "READY":
    case "BUSY":
    case "LOGIN_REQUIRED":
      return "RUNNING";
    case "STARTING":
      return "STARTING";
    case "ERROR":
      return "FAILED";
    default:
      return "STOPPED";
  }
}
