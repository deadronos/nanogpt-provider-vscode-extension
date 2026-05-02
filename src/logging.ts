import * as vscode from "vscode";
import type { NanoGptLogger } from "./client.js";
import { isVerboseLoggingEnabled } from "./config.js";

const OUTPUT_CHANNEL_NAME = "NanoGPT";

/**
 * Creates a NanoGPT logger backed by a VS Code log output channel.
 *
 * In verbose mode, `trace` and `debug` messages are emitted in addition
 * to the standard `info`, `warn`, and `error` levels.
 */
export function createLogger(output: vscode.LogOutputChannel): NanoGptLogger {
  return {
    trace(message) {
      if (isVerboseLoggingEnabled()) {
        output.trace(message);
      }
    },
    debug(message) {
      if (isVerboseLoggingEnabled()) {
        output.debug(message);
      }
    },
    info(message) {
      output.info(message);
    },
    warn(message) {
      output.warn(message);
    },
    error(message) {
      output.error(message);
    },
  };
}

export { OUTPUT_CHANNEL_NAME };
