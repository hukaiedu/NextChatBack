import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { RequestRepository } from "./request.repository.js";

/**
 * 第 2 阶段只读查询;状态流转(RequestService.transition)在
 * 第 5 阶段(Request + Scheduler)实现。
 */
export class RequestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly requestRepo: RequestRepository,
  ) {}

  async getById(id: string): Promise<ModelRequestModel> {
    const request = await this.requestRepo.findById(this.prisma, id);
    if (!request) {
      throw new AppError(ErrorCodes.REQUEST_NOT_FOUND, "Request not found", 404);
    }
    return request;
  }
}
