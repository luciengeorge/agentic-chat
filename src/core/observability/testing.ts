/**
 * Telemetry for tests: spans kept in memory and metrics read on demand, nothing sent anywhere. `install()`
 * registers it the way `startTelemetry` does (the context manager, so spans nest, and the AI SDK integrations);
 * `uninstall()` takes it all back out.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { type MetricData, MetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

import { telemetryConfig } from "#learn/observability/config";
import { createTelemetry } from "#learn/observability/setup";

/** A metric reader that reads only when asked. */
class OnDemandReader extends MetricReader {
  protected override onForceFlush = async () => {};
  protected override onShutdown = async () => {};
}

export function testTelemetry() {
  const spans = new InMemorySpanExporter();
  const reader = new OnDemandReader();
  const telemetry = createTelemetry(
    telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid", OTEL_SERVICE_NAME: "test" }),
    { spanExporter: spans, metricReader: reader },
  );
  return {
    ...telemetry,
    /** Finished spans, oldest first. */
    spans: (): ReadableSpan[] => spans.getFinishedSpans(),
    resetSpans: () => spans.reset(),
    /** Every metric recorded so far, by name. */
    async readMetrics(): Promise<Map<string, MetricData>> {
      const { resourceMetrics } = await reader.collect();
      return new Map(resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).map((m) => [m.descriptor.name, m]));
    },
    install() {
      telemetry.tracerProvider.register();
      registerTelemetry(...telemetry.aiSdk);
    },
    uninstall() {
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
