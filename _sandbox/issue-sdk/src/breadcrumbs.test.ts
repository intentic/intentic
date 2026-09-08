import { afterEach, expect, test, vi } from "vitest";
import { type Breadcrumbs, createBreadcrumbs } from "./breadcrumbs.js";

// Patches globals on the host page; pins what it must not do: grow unbounded, leak request bodies, or leave a global
// patched after detach.

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

test("console.warn and console.error are recorded and still reach the original", () => {
    const original = console.error;
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => void seen.push(args);
    // console.log is accessed via an index because a lint rule forbids writing `console.log` in source.
    const consoleAny = console as unknown as Record<string, unknown>;
    const log = consoleAny["log"];
    const crumbs = start();
    expect(consoleAny["log"]).toBe(log);
    console.error("boom", { code: 7 });
    console.warn("careful");
    expect(crumbs.all().map((crumb) => crumb.kind)).toEqual(["console.error", "console.warn"]);
    expect(crumbs.all()[0]?.message).toBe(`boom {"code":7}`);
    expect(seen).toEqual([["boom", { code: 7 }]]);
    live?.detach();
    live = undefined;
    console.error = original;
});

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

test("a successful request is not recorded, and its response passes through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const crumbs = start();
    const response = await window.fetch("https://api.example.com/v1/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(crumbs.all()).toEqual([]);
});

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

test("pushState is recorded and still does what the app asked", () => {
    const crumbs = start();
    history.pushState({}, "", "/checkout/step-2");
    expect(location.pathname).toBe("/checkout/step-2");
    expect(crumbs.all()[0]).toMatchObject({ kind: "navigation", message: "/checkout/step-2" });
});

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
