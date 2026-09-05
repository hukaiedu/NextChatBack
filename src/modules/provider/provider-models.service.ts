import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { BrowserProviderStatus } from "../../providers/gemini/browser-driver.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { GeminiAdapter, GeminiModelCatalog } from "../../providers/gemini/gemini.types.js";

/**
 * M1:模型目录读取服务 —— Provider 状态矩阵(Review FIX-03):
 *
 * READY          → adapter.listModels()
 * LOGIN_REQUIRED → PROVIDER_LOGIN_REQUIRED(adapter 0 call)
 * BUSY           → PROVIDER_NOT_READY(adapter 0 call)
 * STOPPED        → PROVIDER_NOT_READY(adapter 0 call)
 * STARTING       → PROVIDER_NOT_READY(adapter 0 call)
 * ERROR          → PROVIDER_NOT_READY(adapter 0 call)
 *
 * PROVIDER_MODEL_SWITCH_FAILED 的语义是「目标模型存在且可操作,但点击后无法确认切换成功」
 * (M2 才会有抛点),目录读取在 M1 只区分「Provider 是否就绪」。
 *
 * 状态枚举复用 BrowserProviderStatus(不新增 NOT_CREATED)。
 * 真正的目录读取由 Adapter.listModels 负责(M1 占位,M2 实现);Adapter 不访问 Prisma。
 */
export class ProviderModelsService {
  constructor(
    private readonly geminiAdapter: GeminiAdapter,
    private readonly browserManager: BrowserManager,
  ) {}

  async listModels(): Promise<GeminiModelCatalog> {
    const status = this.browserManager.getStatus();
    if (status !== "READY") {
      if (status === "LOGIN_REQUIRED") {
        throw new AppError(ErrorCodes.PROVIDER_LOGIN_REQUIRED, "Gemini login is required");
      }
      throw new AppError(
        ErrorCodes.PROVIDER_NOT_READY,
        `Provider is not ready (status: ${status}), cannot read the model catalog`,
      );
    }
    return this.geminiAdapter.listModels();
  }
}
