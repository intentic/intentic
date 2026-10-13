import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditSettings } from "@intentic/sandbox-contract";
import { backoffMs, createAuditForwarder } from "./audit-forward.js";
import { fileAuditLog } from "./audit-store.js";

const settings: AuditSettings = { retentionDays: 365, recordReads: false, forwardUrl: "https://siem.example.org/in", forwardSecret: "SIEM_TOKEN" };
const failOnWarn = (message: string, error: Error): never => {
    throw new Error(`${message}: ${error.message}`);
};

interface Sent {
    readonly url: string;
    readonly authorization: string | null;
    readonly body: string;
}

// A collector that refuses the first `refusals` posts, then accepts, keeping what it accepted.
interface Collector {
    readonly fetch: typeof fetch;
    readonly sent: Sent[];
}

const collector = (refusals: number): Collector => {
    const sent: Sent[] = [];
    let left = refusals;
    const answer = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (left > 0) {
            left -= 1;
            return Promise.resolve(new Response("down", { status: 503 }));
        }
        sent.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
        return Promise.resolve(new Response("ok"));
    };
    // SAFETY: the forwarder calls fetch with a URL and an init alone, which is all this answers.
    return { fetch: answer as typeof fetch, sent };
};

test("backoff doubles from five seconds and stops at ten minutes", () => {
    expect([1, 2, 3, 10, 30].map(backoffMs)).toEqual([5000, 10_000, 20_000, 600_000, 600_000]);
});

test("records written after the address was set are sent in order with the bearer token, and a failure waits for a retry", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "audit-forward-"));
    const log = fileAuditLog(historyRoot, failOnWarn);
    log.record({ actor: { kind: "system" }, action: "before.the.address" });
    await log.flush();
    const warnings: string[] = [];
    const remote = collector(1);
    const forwarder = createAuditForwarder({
        historyRoot,
        log,
        settings: () => Promise.resolve(settings),
        secretValue: (name) => Promise.resolve(name === "SIEM_TOKEN" ? "s3cret" : undefined),
        fetch: remote.fetch,
        warn: (message) => warnings.push(message),
    });
    // The first round only places the cursor at the newest record: an address gets what is written after it was set.
    forwarder.kick();
    await forwarder.settled();
    log.record({ actor: { kind: "system" }, action: "first" });
    log.record({ actor: { kind: "system" }, action: "second" });
    await log.flush();

    forwarder.kick();
    await forwarder.settled();
    expect(remote.sent).toEqual([]);
    expect(warnings).toHaveLength(1);
    const waiting = await forwarder.status();
    expect(waiting).toMatchObject({ url: settings.forwardUrl, pending: 2, lastError: "the forward address answered 503" });
    expect(waiting?.nextAttemptAt).toBeGreaterThan(Date.now());
    forwarder.stop();

    // A restart (a new forwarder over the same files) picks up where the cursor stopped, losing nothing.
    const restarted = createAuditForwarder({
        historyRoot,
        log,
        settings: () => Promise.resolve(settings),
        secretValue: () => Promise.resolve("s3cret"),
        fetch: remote.fetch,
        warn: (message) => warnings.push(message),
    });
    restarted.kick();
    await restarted.settled();
    expect(remote.sent.map((sent) => JSON.parse(sent.body).action)).toEqual(["first", "second"]);
    expect(remote.sent.every((sent) => sent.authorization === "Bearer s3cret" && sent.url === settings.forwardUrl)).toBe(true);
    expect(await restarted.status()).toMatchObject({ pending: 0 });
    restarted.stop();
});

test("a forward secret nobody stored sends nothing rather than sending unauthenticated", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "audit-forward-"));
    const log = fileAuditLog(historyRoot, failOnWarn);
    const remote = collector(0);
    const forwarder = createAuditForwarder({
        historyRoot,
        log,
        settings: () => Promise.resolve(settings),
        secretValue: () => Promise.resolve(undefined),
        fetch: remote.fetch,
        warn: () => undefined,
    });
    forwarder.kick();
    await forwarder.settled();
    log.record({ actor: { kind: "system" }, action: "anything" });
    await log.flush();
    forwarder.kick();
    await forwarder.settled();
    expect(remote.sent).toEqual([]);
    expect((await forwarder.status())?.lastError).toBe("no stored secret is named SIEM_TOKEN");
    forwarder.stop();
});
