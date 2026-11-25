import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { CHILDREN } from "../../child-records.js";
import type { ChildRecord, ChildSupervisor } from "../../children.js";
import { receiptedSupervisor } from "../call-receipts.js";
import { mutationReceipts, payloadHash, RECEIPT_KEPT_MS, RECEIPTS_KEPT, subagentReceiptsDocument } from "../mutation-receipts.js";

/* 2026-11-24: a runner's spawn whose answer a dropped link lost was retried as a new call, and started a second child. */

const logger = pino({ level: "silent" });
const root = (): Promise<string> => mkdtemp(join(tmpdir(), "receipts-"));
const key = { conversationId: "parent-1", tool: "spawn", requestId: "call-1" };
const unrecoverable = (): Promise<string> => Promise.reject(new Error("no recovery expected"));

test("a retry under the same key with the same payload replays the first answer and acts once", async () => {
    const receipts = mutationReceipts(await root(), logger);
    let acted = 0;
    const act = async (): Promise<string> => `child-${++acted}`;
    expect(await receipts.run(key, { prompt: "a", model: "m" }, act, unrecoverable)).toEqual({ kind: "ran", value: "child-1" });
    // Key order is no difference.
    expect(await receipts.run(key, { model: "m", prompt: "a" }, act, unrecoverable)).toEqual({ kind: "replayed", value: "child-1" });
    expect(acted).toBe(1);
});

test("the same key asking for something else is refused, and nothing is done", async () => {
    const receipts = mutationReceipts(await root(), logger);
    let acted = 0;
    const act = async (): Promise<string> => `child-${++acted}`;
    await receipts.run(key, { prompt: "a" }, act, unrecoverable);
    expect(await receipts.run(key, { prompt: "b" }, act, unrecoverable)).toMatchObject({ kind: "mismatch" });
    expect(acted).toBe(1);
    // Another conversation's call under the same id is its own.
    expect(await receipts.run({ ...key, conversationId: "parent-2" }, { prompt: "b" }, act, unrecoverable)).toEqual({ kind: "ran", value: "child-2" });
});

test("a retry arriving while the first call still runs waits for its answer instead of acting", async () => {
    const receipts = mutationReceipts(await root(), logger);
    let acted = 0;
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const act = async (): Promise<string> => {
        acted += 1;
        await gate;
        return "child-1";
    };
    const first = receipts.run(key, { prompt: "a" }, act, unrecoverable);
    const second = receipts.run(key, { prompt: "a" }, act, unrecoverable);
    resolve();
    expect(await first).toEqual({ kind: "ran", value: "child-1" });
    expect(await second).toEqual({ kind: "replayed", value: "child-1" });
    expect(acted).toBe(1);
});

test("a call that throws leaves no receipt, so its retry acts afresh", async () => {
    const receipts = mutationReceipts(await root(), logger);
    await expect(receipts.run(key, { prompt: "a" }, () => Promise.reject(new Error("boom")), unrecoverable)).rejects.toThrow("boom");
    expect(await receipts.run(key, { prompt: "a" }, async () => "child-2", unrecoverable)).toEqual({ kind: "ran", value: "child-2" });
});

test("a call a previous process left pending is answered by its recovery, once, and replayed after", async () => {
    const dir = await root();
    const file = join(dir, subagentReceiptsDocument.path);
    const name = `${key.conversationId}\u0000${key.tool}\u0000${key.requestId}`;
    await writeFile(file, JSON.stringify({ [name]: { hash: payloadHash({ prompt: "a" }), state: "pending", at: Date.now() - 1_000 } }));
    const receipts = mutationReceipts(dir, logger);
    let acted = 0;
    const act = async (): Promise<string> => `acted-${++acted}`;
    const recover = async (at: number): Promise<string> => `recovered-since-${at > 0 ? "then" : "never"}`;
    expect(await receipts.run(key, { prompt: "a" }, act, recover)).toEqual({ kind: "recovered", value: "recovered-since-then" });
    expect(await receipts.run(key, { prompt: "a" }, act, recover)).toEqual({ kind: "replayed", value: "recovered-since-then" });
    expect(acted).toBe(0);
});

test("keeps a day of receipts, and no more than its bound", async () => {
    const dir = await root();
    const file = join(dir, subagentReceiptsDocument.path);
    const now = Date.now();
    const old = Object.fromEntries(
        Array.from({ length: RECEIPTS_KEPT + 5 }, (_, index) => [`old-${index}`, { hash: "h", state: "done", at: now - index, result: index }]),
    );
    old["stale"] = { hash: "h", state: "done", at: now - RECEIPT_KEPT_MS - 1, result: 0 };
    await writeFile(file, JSON.stringify(old));
    await mutationReceipts(dir, logger).run(key, { prompt: "a" }, async () => "child", unrecoverable);
    const kept: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(kept)).toHaveLength(RECEIPTS_KEPT);
    expect(kept["stale"]).toBeUndefined();
    expect(kept[`${key.conversationId}\u0000${key.tool}\u0000${key.requestId}`]).toMatchObject({ state: "done", result: "child" });
});

describe("the receipted supervisor", () => {
    const actors = memoryFleet().conversations;
    afterEach(() => actors.holdings(CHILDREN).clear());
    const deps = async () => ({ conversations: actors, historyRoot: await root(), logger });
    const supervisor = (spawned: string[]): ChildSupervisor =>
        // SAFETY: only the three receipted moves are called; the rest of the supervisor is passed through untouched.
        ({
            spawn: async () => {
                spawned.push("spawn");
                return { ok: true, id: `sub-${spawned.length}` };
            },
            send: async () => ({ ok: true }),
            cancel: async () => ({ ok: true }),
        }) as never;

    test("answers a retried spawn with the child the first one started, saying nothing was done again", async () => {
        const spawned: string[] = [];
        const wrapped = receiptedSupervisor(await deps(), "parent-1", "call-1", supervisor(spawned));
        const spec = { prompt: "build it", provider: "claude", model: "sonnet" } as const;
        expect(await wrapped.spawn(spec)).toEqual({ ok: true, id: "sub-1" });
        expect(await wrapped.spawn(spec)).toMatchObject({ ok: true, id: "sub-1", note: expect.stringContaining("nothing was done again") });
        expect(await wrapped.spawn({ ...spec, prompt: "something else" })).toMatchObject({ ok: false });
        expect(spawned).toEqual(["spawn"]);
    });

    test("without a call id it is the supervisor as it was", async () => {
        const plain = supervisor([]);
        expect(receiptedSupervisor(await deps(), "parent-1", undefined, plain)).toBe(plain);
    });

    test("a spawn cut off by a restart answers with the child it had started, or says nothing came of it", async () => {
        const dir = await root();
        const name = "parent-1\u0000spawn\u0000call-9";
        const spec = { prompt: "build it", provider: "claude", model: "sonnet" } as const;
        const at = Date.now() - 5_000;
        // The pending receipt is hashed over the spec exactly as the supervisor sees it.
        await writeFile(join(dir, subagentReceiptsDocument.path), JSON.stringify({ [name]: { hash: payloadHash(spec), state: "pending", at } }));
        // SAFETY: the recovery reads only the parent, the prompt and when it started.
        actors.holdings(CHILDREN).hold("parent-1", "sub-started", { parent: "parent-1", spec, startedAt: at + 10 } as ChildRecord, "sub-started");
        const spawned: string[] = [];
        const wrapped = receiptedSupervisor({ conversations: actors, historyRoot: dir, logger }, "parent-1", "call-9", supervisor(spawned));
        expect(await wrapped.spawn(spec)).toMatchObject({ ok: true, id: "sub-started" });
        expect(spawned).toEqual([]);

        const other = await root();
        await writeFile(join(other, subagentReceiptsDocument.path), JSON.stringify({ [name]: { hash: payloadHash(spec), state: "pending", at: Date.now() + 60_000 } }));
        const fresh = receiptedSupervisor({ conversations: actors, historyRoot: other, logger }, "parent-1", "call-9", supervisor(spawned));
        expect(await fresh.spawn(spec)).toMatchObject({ ok: false, message: expect.stringContaining("nothing came of it") });
        expect(spawned).toEqual([]);
    });
});
