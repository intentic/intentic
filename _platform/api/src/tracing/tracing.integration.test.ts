import { context, logs, metrics, propagation, trace } from "@opentelemetry/api";
import { stubEnv, unstubAllEnvs } from "@intentic/testing/bun";
import { Hono } from "hono";
import { createTracingHttpMiddleware, startTracing, type Tracing } from "./setup.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const PARENT_ID = "8899aabbccddeeff";
let collector: ReturnType<typeof Bun.serve> | undefined;
let tracing: Tracing | undefined;
const requests: { path: string; contentType: string | null; body: Buffer }[] = [];

beforeEach(() => {
    requests.length = 0;
    for (const name of [
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_TRACES_SAMPLER",
        "OTEL_TRACES_SAMPLER_ARG",
        "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
        "OTEL_SDK_DISABLED",
    ]) {
        stubEnv(name, undefined);
    }
    // Export on shutdown, so the test observes flushing rather than racing a periodic export.
    stubEnv("OTEL_BSP_SCHEDULE_DELAY", "60000");
});

afterEach(async () => {
    await tracing?.shutdown();
    tracing = undefined;
    await collector?.stop(true);
    collector = undefined;
    trace.disable();
    context.disable();
    propagation.disable();
    metrics.disable();
    logs.disable();
    unstubAllEnvs();
});

const start = (): void => {
    collector = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
            requests.push({
                path: new URL(request.url).pathname,
                contentType: request.headers.get("content-type"),
                body: Buffer.from(await request.arrayBuffer()),
            });
            return new Response(null, { status: 200 });
        },
    });
    stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.url.toString());
    tracing = startTracing();
};

const finish = async (): Promise<Buffer> => {
    await tracing?.shutdown();
    tracing = undefined;
    return Buffer.concat(requests.map((request) => request.body));
};

const app = () =>
    new Hono().use(createTracingHttpMiddleware()).get("/traced", async (c) => {
        await Promise.resolve();
        return c.json({ traceId: trace.getActiveSpan()?.spanContext().traceId });
    });

test("tracing stays disabled without a collector endpoint", () => {
    expect(startTracing()).toBe(undefined);
});

test("HTTP tracing propagates its parent across an await and exports protobuf spans on shutdown", async () => {
    start();
    const response = await app().request("/traced", { headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ traceId: TRACE_ID });
    const body = await finish();
    expect(requests.length).toBe(1);
    expect(requests[0]?.path).toBe("/v1/traces");
    expect(requests[0]?.contentType).toBe("application/x-protobuf");
    expect(body.includes(Buffer.from(TRACE_ID, "hex"))).toBe(true);
    expect(body.includes(Buffer.from(PARENT_ID, "hex"))).toBe(true);
    expect(body.includes(Buffer.from("GET /traced"))).toBe(true);
    expect(body.includes(Buffer.from("intentic-api"))).toBe(true);
});

test("the default sampler respects an unsampled incoming parent", async () => {
    start();
    const response = await app().request("/traced", { headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-00` } });
    expect(await response.json()).toEqual({ traceId: TRACE_ID });
    await finish();
    expect(requests).toEqual([]);
});

test("OTEL_TRACES_SAMPLER can disable span export", async () => {
    stubEnv("OTEL_TRACES_SAMPLER", "always_off");
    start();
    trace.getTracer("test").startSpan("not-exported").end();
    await finish();
    expect(requests).toEqual([]);
});

test("the ratio sampler reads OTEL_TRACES_SAMPLER_ARG", async () => {
    stubEnv("OTEL_TRACES_SAMPLER", "parentbased_traceidratio");
    stubEnv("OTEL_TRACES_SAMPLER_ARG", "0");
    start();
    trace.getTracer("test").startSpan("not-sampled").end();
    await finish();
    expect(requests).toEqual([]);
});

test("span limits still come from the standard environment variables", async () => {
    stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1");
    start();
    const span = trace.getTracer("test").startSpan("limited");
    span.setAttribute("kept-attribute", "first");
    span.setAttribute("dropped-attribute", "second");
    span.end();
    const body = await finish();
    expect(requests.length).toBe(1);
    expect(body.includes(Buffer.from("kept-attribute"))).toBe(true);
    expect(body.includes(Buffer.from("dropped-attribute"))).toBe(false);
});
