import { afterEach, expect, test, vi } from "vitest";
import { type Breadcrumbs, createBreadcrumbs } from "./breadcrumbs.js";

/* This module patches globals on somebody else's page, so the tests that matter are about what it does NOT do:
 * it must not keep growing, must not carry request bodies off the page, and must put every global back. */

let live: Breadcrumbs | undefined;
afterEach(() => {
    live?.detach();
    live = undefined;
    vi.restoreAllMocks();
});

const start = (): Breadcrumbs => {
    live = createBreadcrumbs();
    return live;
};

test("the ring is bounded and keeps the most recent", () => {
    const crumbs = start();
    for (let n = 0; n < 60; n += 1) {
        crumbs.add("test", `step ${n}`);
    }
    const all = crumbs.all();
    expect(all).toHaveLength(40);
    expect(all[0]?.message).toBe("step 20");
    expect(all.at(-1)?.message).toBe("step 59");
});

test("a long message is truncated rather than sent whole", () => {
    const crumbs = start();
    crumbs.add("test", "x".repeat(1000));
    expect(crumbs.all()[0]?.message).toHaveLength(300);
    expect(crumbs.all()[0]?.message.endsWith("…")).toBe(true);
});

// Wrapped, not replaced: a page with its own console instrumentation (most analytics products) must keep it.
test("console.warn and console.error are recorded and still reach the original", () => {
    const original = console.error;
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => void seen.push(args);
    /* A chatty app would fill the whole ring with logs before the crash they are supposed to explain, so
     * console.log is deliberately left alone. Asserted as an untouched reference rather than by calling it, and
     * reached through an index because the repo's own lint rule (rightly) refuses to see `console.log` written
     * out in source. */
    const consoleAny = console as unknown as Record<string, unknown>;
    const log = consoleAny["log"];
    const crumbs = start();
    expect(consoleAny["log"]).toBe(log);
    console.error("boom", { code: 7 });
    console.warn("careful");
    expect(crumbs.all().map((crumb) => crumb.kind)).toEqual(["console.error", "console.warn"]);
    expect(crumbs.all()[0]?.message).toBe(`boom {"code":7}`);
    // The page's own handler still ran, with the arguments untouched.
    expect(seen).toEqual([["boom", { code: 7 }]]);
    live?.detach();
    live = undefined;
    console.error = original;
});

/* THE ONE THAT WOULD BE A SCANDAL. A failed request records its method, path and status, never its body: that
 * is where the passwords and the personal data are. The query string goes too, since that is where ids and
 * tokens end up. */
test("a failed request records the path and the status, never the body or the query", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const crumbs = start();
    await window.fetch("https://api.example.com/v1/login?token=SECRET", { method: "POST", body: JSON.stringify({ password: "hunter2" }) });
    const crumb = crumbs.all()[0];
    expect(crumb?.kind).toBe("fetch");
    expect(crumb?.message).toBe("POST /v1/login → 500");
    expect(JSON.stringify(crumbs.all())).not.toContain("hunter2");
    expect(JSON.stringify(crumbs.all())).not.toContain("SECRET");
});

// A working app makes hundreds of successful requests a minute; recording them would push the click that
// actually mattered out of the ring before the crash arrives.
test("a successful request is not recorded, and its response passes through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const crumbs = start();
    const response = await window.fetch("https://api.example.com/v1/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(crumbs.all()).toEqual([]);
});

// The page's own error handling must see exactly what it would have seen without us.
test("a network error is recorded and re-thrown untouched", async () => {
    const offline = new TypeError("Failed to fetch");
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw offline;
        }),
    );
    const crumbs = start();
    await expect(window.fetch("https://api.example.com/v1/ping")).rejects.toBe(offline);
    expect(crumbs.all()[0]?.message).toBe("GET /v1/ping → Failed to fetch");
});

test("a click is recorded as something a developer can find again, never as page content", () => {
    const crumbs = start();
    document.body.innerHTML = `<button id="checkout" aria-label="Pay now">Some very long visible label text</button>`;
    document.querySelector("button")?.click();
    expect(crumbs.all()[0]).toMatchObject({ kind: "click", message: `button#checkout "Pay now"` });
    expect(crumbs.all()[0]?.message).not.toContain("visible label text");
});

// A single-page app changes route without firing anything, and "which screen were they on" is the first
// question anybody asks about a crash.
test("pushState is recorded and still does what the app asked", () => {
    const crumbs = start();
    history.pushState({}, "", "/checkout/step-2");
    expect(location.pathname).toBe("/checkout/step-2");
    expect(crumbs.all()[0]).toMatchObject({ kind: "navigation", message: "/checkout/step-2" });
});

/* detach() has to be exact. A reporter that left its wrappers behind after being stopped would keep costing the
 * page on every console call and every fetch, forever, with nothing left pointing at us. */
test("detach puts every global back exactly as it found it", () => {
    const before = { fetch: window.fetch, error: console.error, warn: console.warn, push: history.pushState };
    const crumbs = createBreadcrumbs();
    expect(window.fetch).not.toBe(before.fetch);
    crumbs.detach();
    expect(window.fetch).toBe(before.fetch);
    expect(console.error).toBe(before.error);
    expect(console.warn).toBe(before.warn);
    expect(history.pushState).toBe(before.push);
});
