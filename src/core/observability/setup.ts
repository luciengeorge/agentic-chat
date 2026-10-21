/**
 * Turning OpenTelemetry on: the providers that collect spans and metrics and send them to a collector, and the AI
 * SDK's integrations that report every model call. Called once per process, and only when `telemetryConfig` says
 * so. When it isn't called, nothing anywhere is registered: the OpenTelemetry API's tracer is its built-in no-op,
 * and the AI SDK skips telemetry entirely.
 *
 * - A tracer provider batches finished spans and posts them over OTLP/HTTP to `<endpoint>/v1/traces`.
 * - A meter provider adds up metrics and posts them every `metricIntervalMs` to `<endpoint>/v1/metrics`.
 * - `registerTelemetry` gives the AI SDK two integrations: `@ai-sdk/otel`'s `OpenTelemetry`, which makes a span
 *   per model call with the GenAI attributes, and `modelCallMetrics`, which counts tokens and cost.
 */
import { OpenTelemetry } from "@ai-sdk/otel";
import { metrics, type Meter, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { type MetricReader, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
  type SpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { registerTelemetry, type Telemetry as AiSdkTelemetry } from "ai";

import type { TelemetryConfig } from "#learn/observability/config";

import { type AppMetrics, createMetrics, modelCallMetrics } from "#learn/observability/metrics";

export interface Telemetry {
  tracer: Tracer;
  meter: Meter;
  metrics: AppMetrics;
  /** Sends what's buffered now (tests, scripts that exit). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The AI SDK's OpenTelemetry integration with prompts and replies left off the spans unless `captureContent`. The
 * SDK records them by default; its spans take the setting from each call's start event, so it's overridden there.
 */
export class GenAiSpans extends OpenTelemetry {
  constructor(
    tracer: Tracer,
    private readonly captureContent: boolean,
  ) {
    super({ tracer });
  }

  override onStart(event: Parameters<OpenTelemetry["onStart"]>[0]): void {
    super.onStart({ ...event, recordInputs: this.captureContent, recordOutputs: this.captureContent });
  }
}

export interface TelemetryParts {
  /** Where spans go. The OTLP exporter unless given (tests pass an in-memory one). */
  spanExporter?: SpanExporter;
  /** How metrics are read. A periodic OTLP export unless given. */
  metricReader?: MetricReader;
}

/** Builds the providers and the AI SDK integrations, without registering anything globally. */
export function createTelemetry(
  config: TelemetryConfig,
  parts: TelemetryParts = {},
): Telemetry & { aiSdk: AiSdkTelemetry[]; tracerProvider: NodeTracerProvider; meterProvider: MeterProvider } {
  const resource = resourceFromAttributes({ "service.name": config.serviceName });
  const processor: SpanProcessor = parts.spanExporter
    ? new SimpleSpanProcessor(parts.spanExporter)
    : new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` }));
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
  const reader =
    parts.metricReader ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
      exportIntervalMillis: config.metricIntervalMs,
    });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });

  const tracer = tracerProvider.getTracer("agentic-chat");
  const meter = meterProvider.getMeter("agentic-chat");
  const appMetrics = createMetrics(meter);
  return {
    tracer,
    meter,
    metrics: appMetrics,
    tracerProvider,
    meterProvider,
    aiSdk: [new GenAiSpans(tracerProvider.getTracer("gen_ai"), config.captureContent), modelCallMetrics(appMetrics)],
    async flush() {
      await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    async shutdown() {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

const STARTED = Symbol.for("agentic-chat.telemetry");

type Store = typeof globalThis & { [STARTED]?: Telemetry | null };

/**
 * Starts telemetry for this process when the config says so, and returns it; null when it's off. The first call
 * decides: later calls return the same thing, since the dev server loads modules more than once.
 */
export function startTelemetry(config: TelemetryConfig): Telemetry | null {
  const store = globalThis as Store;
  if (store[STARTED] !== undefined) return store[STARTED];
  if (!config.enabled) return (store[STARTED] = null);
  const telemetry = createTelemetry(config);
  // The tracer provider's context manager is what makes a span started inside another its child.
  telemetry.tracerProvider.register();
  metrics.setGlobalMeterProvider(telemetry.meterProvider);
  registerTelemetry(...telemetry.aiSdk);
  return (store[STARTED] = telemetry);
}
