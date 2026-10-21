// @vitest-environment node
import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { conversationLogFile, telemetryConfig } from "#learn/observability/config";
import { startTelemetry } from "#learn/observability/setup";

describe("telemetryConfig", () => {
  it("is off with no collector configured, as in every environment today", () => {
    expect(telemetryConfig({})).toMatchObject({ enabled: false, endpoint: null, captureContent: false });
    expect(conversationLogFile({})).toBeNull();
  });

  it("turns on with OTEL_EXPORTER_OTLP_ENDPOINT, and off again with OTEL_SDK_DISABLED", () => {
    expect(telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/" })).toMatchObject({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "agentic-chat",
    });
    expect(
      telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "true" }).enabled,
    ).toBe(false);
  });

  it("captures prompts and replies only when asked", () => {
    expect(
      telemetryConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://x",
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
      }).captureContent,
    ).toBe(true);
  });
});

describe("startTelemetry, off", () => {
  it("registers nothing: no AI SDK integration, and the global tracer stays OpenTelemetry's no-op", () => {
    expect(startTelemetry(telemetryConfig({}))).toBeNull();
    expect(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS).toBeUndefined();
    const span = trace.getTracer("anything").startSpan("nothing");
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});
