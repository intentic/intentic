import { REQUEST_ID_HEADER } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { createPerfTracker, type PerfFields } from "../platform/perf.js";
import { services } from "../route-testing.js";
import { pino } from "pino";

/* THE CORRELATION, ACROSS THE WIRE. Both halves of a slow interaction were already measured and could not be
 * put together: the browser times what the user waited for, the daemon times what it served, and on a sandbox
 * answering several calls a second the only way to pair them was by timestamp and hope.
 *
 * Driven over the real HTTP surface, because the thing under test is a header surviving the trip. */

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

test("a caller that sends no id leaves the field absent rather than empty", async () => {
    const { spans, perf } = spanning();
    const app = createApp(services({ perf }));

    // The CLI, an extension's own fetch, curl. An empty string here would read as an id nobody could match.
    await app.request("/health");

    const fields = httpSpan(spans) ?? {};
    expect(fields).toMatchObject({ path: "/health" });
    expect("requestId" in fields).toBe(false);
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
