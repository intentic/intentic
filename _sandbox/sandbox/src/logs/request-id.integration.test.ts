import { REQUEST_ID_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import { createApp } from "../app.js";
import { createPerfTracker, type PerfFields } from "../system/resources/perf.js";
import { services } from "../harness/route-services.testing.js";
import { pino } from "pino";

/* THE CORRELATION, ACROSS THE WIRE. */

const spanning = () => {
    const spans: { op: string; fields: PerfFields }[] = [];
    const tracker = createPerfTracker(pino({ level: "silent" }));
    return {
        spans,
        perf: { ...tracker, record: (op: string, _ms: number, fields: PerfFields) => void spans.push({ op, fields }) } as never,
    };
};

const httpSpan = (spans: { op: string; fields: PerfFields }[]) => spans.find((span) => span.op === "http.request")?.fields;

test("the browser's request id is echoed onto the daemon line that served the call", async () => {
    const { spans, perf } = spanning();
    const app = createApp(services({ perf }));

    await app.request("/health", { headers: { [REQUEST_ID_HEADER]: "req-abc-123" } });

    // The join key: one grep now pairs this line with the browser's own span for the same call.
    expect(httpSpan(spans)).toMatchObject({ path: "/health", requestId: "req-abc-123" });
});

test("the id is echoed on the answer, so the caller holds the key to the daemon's lines", async () => {
    const app = createApp(services());
    const response = await app.request("/health", { headers: { [REQUEST_ID_HEADER]: "req-abc-123" } });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-abc-123");
});

test("a caller that sends no id gets one made for it, on the line and on the answer alike", async () => {
    const { spans, perf } = spanning();
    const app = createApp(services({ perf }));

    // The CLI, an extension's own fetch, curl: without an id of its own, its request's lines shared no key at all.
    const response = await app.request("/health");

    const made = response.headers.get(REQUEST_ID_HEADER);
    expect(made).toMatch(/^[0-9a-f-]{36}$/);
    expect(httpSpan(spans)).toMatchObject({ path: "/health", requestId: made });
});

// A turn's MCP call lasts as long as the tool it runs; under http.request those topped every ranking.
test("a turn's MCP call is timed as its own op, not as an HTTP request a person waited on", async () => {
    const { spans, perf } = spanning();
    const app = createApp(services({ perf }));

    await app.request("/mcp/laptop", { method: "POST", body: "{}" });

    expect(spans.find((span) => span.op === "mcp.call")?.fields).toMatchObject({ path: "/mcp/laptop" });
    expect(httpSpan(spans)).toBeUndefined();
});

test("the preflight allows the header, or the browser would silently never send it", async () => {
    const app = createApp(services());
    const response = await app.request("/health", {
        method: "OPTIONS",
        headers: { origin: "https://app.intentic.dev", "access-control-request-method": "GET", "access-control-request-headers": REQUEST_ID_HEADER },
    });

    // A header the preflight does not allow is one the browser drops without telling anyone, which would leave
    // the daemon's side of the correlation permanently and inexplicably empty.
    expect((response.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(REQUEST_ID_HEADER);
});
