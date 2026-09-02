import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

import { REQUEST_ID_HEADER } from "../../config/constants.js";

/** 给每个请求生成/透传 x-request-id,用于日志串联 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.length > 0 ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
