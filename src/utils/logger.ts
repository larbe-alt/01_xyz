export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

export function createLogger(
  name: string,
  opts: { level?: LogLevel; json?: boolean } = {},
): Logger {
  const minLevel = LEVEL_ORDER[opts.level ?? "info"];
  const json = opts.json ?? false;

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>, ctx?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < minLevel) return;
    const ts = new Date().toISOString();
    if (json) {
      const line = JSON.stringify({ ts, level, name, msg, ...ctx, ...data });
      process.stderr.write(line + "\n");
    } else {
      const prefix = `${ts} [${level.toUpperCase().padEnd(5)}] ${name}`;
      const extra = { ...ctx, ...data };
      const suffix = Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
      process.stderr.write(`${prefix}: ${msg}${suffix}\n`);
    }
  }

  function makeLogger(ctx?: Record<string, unknown>): Logger {
    return {
      debug: (msg, data) => emit("debug", msg, data, ctx),
      info: (msg, data) => emit("info", msg, data, ctx),
      warn: (msg, data) => emit("warn", msg, data, ctx),
      error: (msg, data) => emit("error", msg, data, ctx),
      child: (extra) => makeLogger({ ...ctx, ...extra }),
    };
  }

  return makeLogger();
}
