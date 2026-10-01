type LogLevel = "debug" | "info" | "warn" | "error";

type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

type LogMeta = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN = /pass|secret|token|cookie|authorization|apikey|api_key/i;
const MAX_ARRAY_PREVIEW = 10;

function redactValue(value: unknown, key?: string): LogValue {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_PREVIEW).map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactValue(nestedValue, nestedKey)]),
    );
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  return String(value);
}

function redactMeta(meta: LogMeta): Record<string, LogValue> {
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, redactValue(value, key)]));
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: LogMeta) {
  if (level === "debug" && process.env.NODE_ENV === "production") {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? redactMeta(meta) : {}),
  };

  const line = JSON.stringify(payload);

  switch (level) {
    case "debug":
      console.debug(line);
      return;
    case "info":
      console.info(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
      return;
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: LogMeta) => writeLog("debug", scope, message, meta),
    info: (message: string, meta?: LogMeta) => writeLog("info", scope, message, meta),
    warn: (message: string, meta?: LogMeta) => writeLog("warn", scope, message, meta),
    error: (message: string, meta?: LogMeta) => writeLog("error", scope, message, meta),
  };
}
