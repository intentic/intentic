import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonClient, GatewayCtx } from "@intentic/connector-runtime";
import { unstubbed } from "@intentic/testing";
import type { Connection } from "../google/accounts.js";
import type { Session } from "../google/session.js";
import { startWatcher } from "./poller.js";
import { watermarkPath, writeWatermark } from "./watermark.js";

const connection: Connection = { name: "work", email: "me@example.com", access: "read", mode: "user", credential: undefined, problem: undefined };
const session: Session = { connection, token: async () => "token", refresh: async () => "token" };

let root = "";
const realFetch = globalThis.fetch;
const realWorkspace = process.env["INTENTIC_WORKSPACE"];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "google-poller-"));
    // workspaceRoot() prefers the env over ctx.workspaceRoot; pin it so the mark lands in the temp tree.
    process.env["INTENTIC_WORKSPACE"] = root;
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    if (realWorkspace === undefined) {
        delete process.env["INTENTIC_WORKSPACE"];
    } else {
        process.env["INTENTIC_WORKSPACE"] = realWorkspace;
    }
    await rm(root, { recursive: true, force: true });
});

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("a mail poll slower than its interval is never overlapped by the next tick", async () => {
    await writeWatermark(watermarkPath(root, connection.name), { historyId: "100" });
    let historyCalls = 0;
    let releaseHistory: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        // path-literals: content, "/history" is Gmail's history API in a stubbed fetch, not the daemon's history root
        if (url.includes("/history")) {
            historyCalls += 1;
            return await new Promise<Response>((resolve) => {
                releaseHistory = resolve;
            });
        }
        return json({ items: [] });
    }) as typeof fetch;
    const ctx: GatewayCtx = {
        api: unstubbed<GatewayCtx["api"]>("api", {}),
        daemon: unstubbed<DaemonClient<{ readonly provider: string }>>("daemon", { dispatch: async () => {} }),
        workspaceRoot: root,
        log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const watcher = startWatcher(ctx, connection, session, () => {}, { mailIntervalMs: 5, calendarIntervalMs: 3_600_000 });
    try {
        // Twenty intervals pass while the first history call hangs: each tick joins it instead of starting another.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(historyCalls).toBe(1);
        releaseHistory(json({ history: [], historyId: "101" }));
        // Once it settles, the next tick polls again.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(historyCalls).toBe(2);
    } finally {
        watcher.stop();
        releaseHistory(json({ history: [], historyId: "102" }));
    }
});
