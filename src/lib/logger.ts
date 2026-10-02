type LogLevel = "debug" | "info" | "warn" | "error";

type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

type LogMeta = Record<string, unknown>;

// A key is split into its words (camelCase, snake_case, kebab-case), so `inputTokens` and `passages` stay readable
// while `accessToken`, `x-api-key` and `db_password` don't.
const SENSITIVE_WORDS = new Set([
  "pass",
  "passwd",
  "password",
  "passphrase",
  "secret",
  "token",
  "cookie",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "apikey",
]);
const MAX_ARRAY_PREVIEW = 10;
const REDACTED = "[REDACTED]";

function keyWords(key: string) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string) {
  const words = keyWords(key);
  return words.some((word, i) => SENSITIVE_WORDS.has(word) || (word === "api" && words[i + 1] === "key"));
}

// The password in a connection string (postgres://ac:ac@host/db), and a bearer token, wherever they turn up:
// error messages and stacks quote them.
function redactString(value: string) {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s/@]*@/gi, `$1:${REDACTED}@`)
    .replace(/\bbearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`);
}

// `ancestors` holds the objects above this one, so a cycle prints as "[Circular]" while an object that merely
// appears twice prints twice.
function redactValue(value: unknown, key: string | undefined, ancestors: Set<object>): LogValue {
  if (key && isSensitiveKey(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (value instanceof Error) {
    return {
      message: redactString(value.message),
      name: value.name,
      stack: value.stack && redactString(value.stack),
    };
  }

  if (value && typeof value === "object") {
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_PREVIEW).map((item) => redactValue(item, undefined, ancestors));
      }
      return Object.fromEntries(
        Object.entries(value).map(([nestedKey, nested]) => [nestedKey, redactValue(nested, nestedKey, ancestors)]),
      );
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }

  return String(value);
}

function redactMeta(meta: LogMeta): Record<string, LogValue> {
  const ancestors = new Set<object>([meta]);
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, redactValue(value, key, ancestors)]));
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
