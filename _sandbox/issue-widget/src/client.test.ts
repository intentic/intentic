import type { IssuePublicConfig } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { createClient, type IssueClient } from "./client.js";

/* What actually goes over the wire, and what the SDK refuses to let go over it. Everything here mocks `fetch`,
 * because the interesting behaviour is entirely in the shape of the request and in which failures are allowed
 * to reach the page (none of them). */

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
                // Difficulty 1: a real puzzle, solved in a handful of hashes, so the test exercises the path
                // without spending a second of CPU on it.
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
    const id = await live.captureException(new TypeError("x is not a function"), { route: "/checkout" });

    expect(id).toBe("4f3a1b2c");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://sandbox.example/intake/bugs/report");
    const report = sent[0]?.body["report"] as Record<string, unknown>;
    expect(report["kind"]).toBe("crash");
    expect(report["message"]).toBe("TypeError: x is not a function");
    expect(String(report["stack"])).toContain("TypeError");
    expect(report["release"]).toBe("a1b2c3d");
    expect(report["url"]).toBe(location.href);
    expect(report["userAgent"]).toBe(navigator.userAgent);
    // The per-call context wins over the client-wide one where they collide, and both survive.
    expect(report["context"]).toEqual({ tier: "pro", route: "/checkout" });
    // A crash must survive the page unloading, which is what keepalive buys.
    expect(sent[0]?.init.keepalive).toBe(true);
});

/* THE FIELD THAT MAKES THE WHOLE PRODUCT DIFFERENT. Without a release the agent is guessing which version of a
 * file it is reading; with one it checks the build out. It must therefore never be silently dropped. */
test("no release is sent when the host set none, rather than a wrong one", async () => {
    const sent = fakeDaemon();
    const live = await started();
    await live.captureException(new Error("boom"));
    expect(sent[0]?.body["report"]).not.toHaveProperty("release");
});

test("a written report carries what the person typed, and their details as their own claim", async () => {
    const sent = fakeDaemon();
    const live = await started();
    await live.report({ description: "the pay button does nothing\nI tried twice", email: "someone@example.com" });
    const report = sent[0]?.body["report"] as Record<string, unknown>;
    expect(report["kind"]).toBe("report");
    expect(report["description"]).toBe("the pay button does nothing\nI tried twice");
    // The headline is the first line: the daemon lists the row by the description, and keeps this as the
    // fallback for one that arrives empty.
    expect(report["message"]).toBe("the pay button does nothing");
    expect(report["reporter"]).toEqual({ email: "someone@example.com" });
});

/* beforeSend is the host's last word on what leaves the page, so both directions have to hold: a modified
 * report is what gets sent, and a null one is not sent at all. */
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

// A beforeSend that throws is the host's bug, and it must cost them one report rather than their page.
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

/* THE RULE ABOVE ALL OTHERS: this must never be the thing that breaks the page it is watching. An offline
 * browser, a refused report and a sleeping sandbox all resolve quietly. */
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

/* A crash has no second to spend on a puzzle and nobody waiting to watch it be spent, so the proof of work
 * guards written reports only. Getting this backwards would mean no crash reports at all. */
test("the puzzle is solved for a written report and skipped for a crash", async () => {
    const sent = fakeDaemon({ antiBot: "pow" });
    const live = await started();

    await live.captureException(new Error("boom"));
    expect(sent[0]?.body).not.toHaveProperty("powNonce");

    await live.report({ description: "a thing" });
    expect(String(sent[1]?.body["powNonce"])).toMatch(/^s\.a\.b:\d+$/);
});

// A browser proves itself by its origin; a key belongs to an app that has no origin to be judged by, and must
// be sent when the host set one.
test("an ingest key rides every report when the host set one", async () => {
    const sent = fakeDaemon();
    const live = await started({ key: "intake_abc" });
    await live.captureException(new Error("boom"));
    expect(sent[0]?.body["key"]).toBe("intake_abc");
    // The same client id every time: it is the rate-limit key, not identity.
    expect(String(sent[0]?.body["clientId"])).toHaveLength(36);
});

// The config fetch is the reachability probe, and it is the ONE failure that should reach the caller: a
// reporter that silently posts into the void is worse than one that says it could not start.
test("a sandbox that refuses the config fails the start, with the daemon's own sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403 })));
    await expect(createClient({ automationId: "bugs", base: "https://sandbox.example" })).rejects.toThrow("origin not allowed");
});
