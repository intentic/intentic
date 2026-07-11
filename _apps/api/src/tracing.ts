import { httpInstrumentationMiddleware } from "@hono/otel";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { MiddlewareHandler } from "hono";

// Single source of the service identity, used by both the tracer resource and the HTTP middleware. OTEL_* are
// read straight from the environment — OTel defines its own env-var contract that the SDK/exporter auto-read,
// so tracing stays on the standard rather than the typed purenv config.
export const SERVICE_NAME = process.env[`OTEL_SERVICE_NAME`] ?? `intentic-api`;
export const SERVICE_VERSION = `0.0.0`;

export interface Tracing {
    shutdown: () => Promise<void>;
}

// Explicit, no auto-instrumentation: Bun cannot monkey-patch the Node http/fetch layers, so we register a
// provider here and rely on @hono/otel for the server span. Tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set, keeping production overhead at zero.
export const startTracing = (): Tracing | undefined => {
    const endpoint = process.env[`OTEL_EXPORTER_OTLP_ENDPOINT`]?.trim();
    if (!endpoint) {
        return undefined;
    }

    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
        }),
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, ``)}/v1/traces` }))],
    });

    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    return { shutdown: () => provider.shutdown() };
};

// Server span per request. @hono/otel extracts the incoming W3C traceparent (so a request stays in the same
// trace as its caller) and records http.* semantic-convention attributes. Naming spans by the real pathname
// keeps each oRPC route distinct in the waterfall (the mount is the catch-all "/rpc/*").
export const createTracingHttpMiddleware = (): MiddlewareHandler =>
    httpInstrumentationMiddleware({
        serviceName: SERVICE_NAME,
        serviceVersion: SERVICE_VERSION,
        disableTracing: !process.env[`OTEL_EXPORTER_OTLP_ENDPOINT`]?.trim(),
        spanNameFactory: (c) => `${c.req.method} ${new URL(c.req.url).pathname}`,
    });
