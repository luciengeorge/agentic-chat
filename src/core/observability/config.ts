/**
 * Whether observability is on, read from the standard OpenTelemetry variables. Everything is off by default: with
 * no collector configured, nothing is registered, nothing is wrapped, and the app runs exactly as it did.
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` turns traces and metrics on, sent over OTLP/HTTP to that address
 *   (`http://localhost:4318` for the grafana/otel-lgtm container in compose.yaml). `OTEL_SDK_DISABLED=true` turns
 *   them off again, as every OpenTelemetry SDK honours.
 * - `OTEL_SERVICE_NAME` names the app in the traces (`agentic-chat` unless set).
 * - `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` also records prompts and replies on the model spans.
 *   They hold tenant documents, so it's off unless asked for, as the GenAI conventions recommend.
 * - `CONVERSATION_LOG_FILE` turns on the conversation log: each finished chat turn is appended to that file as one
 *   JSON line, through the outbox (`#learn/observability/conversation-log`).
 */

type Env = Record<string, string | undefined>;

export interface TelemetryConfig {
  enabled: boolean;
  /** The collector's base URL; `/v1/traces` and `/v1/metrics` are added to it. */
  endpoint: string | null;
  serviceName: string;
  captureContent: boolean;
  /** How often metrics are sent. */
  metricIntervalMs: number;
}

export function telemetryConfig(env: Env = process.env): TelemetryConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") || null;
  const disabled = env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";
  return {
    enabled: endpoint !== null && !disabled,
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "agentic-chat",
    captureContent: env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim().toLowerCase() === "true",
    metricIntervalMs: Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 10_000,
  };
}

/** The conversation log's file, or null when the log is off. */
export function conversationLogFile(env: Env = process.env): string | null {
  return env.CONVERSATION_LOG_FILE?.trim() || null;
}
