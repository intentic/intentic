import type { IssuePublicConfig } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { createClient, type IssueClient } from "./client.js";

// Mocks fetch throughout; pins the shape of each request and that no failure ever reaches the page.

const CONFIG: IssuePublicConfig = {
    automationId: "bugs",
    title: "Report a problem",
    prompt: "What went wrong?",
    thanks: "Thanks",
    askEmail: false,
    accent: "#e47100",
    captureCrashes: false,
    antiBot: "off",
};

interface Sent {
    readonly url: string;
    readonly body: Record<string, unknown>;
    readonly init: RequestInit;
}

// A daemon that answers the config fetch and records every report POSTed to it.
const fakeDaemon = (over: Partial<IssuePublicConfig> = {}, reportStatus = 200): Sent[] => {
    const sent: Sent[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/config")) {
                return new Response(JSON.stringify({ ...CONFIG, ...over }), { status: 200 });
            }
            if (url.includes("/challenge")) {
                // Difficulty 1 keeps the puzzle real but cheap: a handful of hashes, not CPU-seconds.
                return new Response(JSON.stringify({ salt: "s.a.b", difficulty: 1 }), { status: 200 });
            }
            sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, init: init ?? {} });
            return reportStatus === 200
                ? new Response(JSON.stringify({ ok: true, id: "4f3a1b2c" }), { status: 200 })
                : new Response(JSON.stringify({ error: "rate limited" }), { status: reportStatus });
        }),
    );
    return sent;
};

let client: IssueClient | undefined;
afterEach(() => {
    client?.stop();
    client = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const started = async (options: Partial<Parameters<typeof createClient>[0]> = {}): Promise<IssueClient> => {
    client = await createClient({ automationId: "bugs", base: "https://sandbox.example", ...options });
    return client;
};

test("a captured error arrives with its stack, the page, the build and the browser", async () => {
    const sent = fakeDaemon();
    const live = await started({ release: "a1b2c3d", context: { tier: "pro" } });
    const error = new TypeError("x is not a function");
    const id = await live.captureException(error, { route: "/checkout" });

    expect(id).toBe("4f3a1b2c");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://sandbox.example/intake/bugs/report");
    const report = sent[0]?.body["report"] as Record<string, unknown>;
    expect(report["kind"]).toBe("crash");
    expect(report["message"]).toContain(error.message);
    expect(String(report["stack"])).toContain("TypeError");
    expect(report["release"]).toBe("a1b2c3d");
    expect(report["url"]).toBe(location.href);
    expect(report["userAgent"]).toBe(navigator.userAgent);
    expect(report["context"]).toEqual({ tier: "pro", route: "/checkout" });
    expect(sent[0]?.init.keepalive).toBe(true);
});

test("no release is sent when the host set none, rather than a wrong one", async () => {
    const sent = fakeDaemon();
    const live = await started();
    await live.captureException(new Error("boom"));
    expect(sent[0]?.body["report"]).not.toHaveProperty("release");
});

test("a written report carries what the person typed, and their details as their own claim", async () => {
    const sent = fakeDaemon();
    const live = await started();
    const description = "the pay button does nothing\nI tried twice";
    await live.report({ description, email: "someone@example.com" });
    const report = sent[0]?.body["report"] as Record<string, unknown>;
    expect(report["kind"]).toBe("report");
    expect(report["description"]).toBe(description);
    expect(report["message"]).toBe(description.split("\n")[0]);
    expect(report["reporter"]).toEqual({ email: "someone@example.com" });
});

test("beforeSend can rewrite a report or drop it entirely", async () => {
    const sent = fakeDaemon();
    const live = await started({
        beforeSend: (report) => (report.message.includes("extension://") ? null : { ...report, message: report.message.replace(/\d{4,}/g, "<n>") }),
    });
    expect(await live.captureException(new Error("order 993412 failed"))).toBe("4f3a1b2c");
    expect(await live.captureException(new Error("chrome-extension://abc exploded"))).toBeUndefined();
    expect(sent).toHaveLength(1);
    const kept = sent[0]?.body["report"] as Record<string, unknown> | undefined;
    expect(kept?.["message"]).toBe("Error: order <n> failed");
});

test("a throwing beforeSend drops the report instead of the page", async () => {
    const sent = fakeDaemon();
    const live = await started({
        beforeSend: () => {
            throw new Error("host bug");
        },
    });
    await expect(live.captureException(new Error("boom"))).resolves.toBeUndefined();
    expect(sent).toEqual([]);
});

test("a refused or failed send resolves quietly", async () => {
    fakeDaemon({}, 429);
    const live = await started();
    await expect(live.captureException(new Error("boom"))).resolves.toBeUndefined();

    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        }),
    );
    await expect(live.report({ description: "offline" })).resolves.toBeUndefined();
});

test("the puzzle is solved for a written report and skipped for a crash", async () => {
    const sent = fakeDaemon({ antiBot: "pow" });
    const live = await started();

    await live.captureException(new Error("boom"));
    expect(sent[0]?.body).not.toHaveProperty("powNonce");

    await live.report({ description: "a thing" });
    expect(String(sent[1]?.body["powNonce"])).toMatch(/^s\.a\.b:\d+$/);
});

test("an ingest key rides every report when the host set one", async () => {
    const sent = fakeDaemon();
    const live = await started({ key: "intake_abc" });
    await live.captureException(new Error("boom"));
    expect(sent[0]?.body["key"]).toBe("intake_abc");
    expect(String(sent[0]?.body["clientId"])).toHaveLength(36);
});

test("a sandbox that refuses the config fails the start, with the daemon's own sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403 })));
    await expect(createClient({ automationId: "bugs", base: "https://sandbox.example" })).rejects.toThrow("origin not allowed");
});
