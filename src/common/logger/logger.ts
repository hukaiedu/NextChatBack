import pino from "pino";

import { APP_NAME } from "../../config/constants.js";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    name: APP_NAME,
    level: level as pino.Level,
  });
}
