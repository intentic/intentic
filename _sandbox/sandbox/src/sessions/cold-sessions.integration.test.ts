import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshRuntime, idleConversation } from "../conversations/actor/conversation-state.js";
import { conversationEntry } from "../conversations/registry/agents-store.testing.js";
import { busySessions, COLD_SESSION_MS, coldSessionsChore, type ColdSessionsDeps, sweepColdSessions } from "./cold-sessions.js";
import { thawClaudeSession } from "./session-freeze.js";

// The hourly pass that compresses Claude sessions nobody touched in a week, over a real store on disk.

const DAY_MS = 24 * 60 * 60_000;

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

const storeWith = async (): Promise<{ readonly store: string; readonly project: string }> => {
    const store = await mkdtemp(join(tmpdir(), "cold-sessions-"));
    roots.push(store);
    const project = join(await realpath(store), "projects", "-work");
    await mkdir(project, { recursive: true });
    return { store, project };
};

// A file of JSONL written `ageDays` ago.
const written = async (path: string, ageDays: number): Promise<string> => {
    const text = `${JSON.stringify({ type: "user", message: { content: `said at ${path}` } })}\n`.repeat(40);
    await writeFile(path, text, { mode: 0o600 });
    const at = new Date(Date.now() - ageDays * DAY_MS);
    await utimes(path, at, at);
    return text;
};

// A session's transcript, and one subagent's record beside it when its age is given.
const sessionIn = async (project: string, ageDays: number, subagentAgeDays?: number): Promise<string> => {
    const id = randomUUID();
    await written(join(project, `${id}.jsonl`), ageDays);
    if (subagentAgeDays !== undefined) {
        await mkdir(join(project, id, "subagents"), { recursive: true });
        await written(join(project, id, "subagents", "agent-a9.jsonl"), subagentAgeDays);
    }
    return id;
};

const depsOf = (store: string, overrides: Partial<ColdSessionsDeps> = {}): ColdSessionsDeps => ({
    store,
    busy: () => new Set(),
    listed: async () => [],
    logger: silent,
    openFiles: async () => new Set(),
    ...overrides,
});

test("a pass compresses only the sessions whose files all went cold and that nothing keeps plain", async () => {
    const { store, project } = await storeWith();
    const cold = await sessionIn(project, 8, 9);
    const fresh = await sessionIn(project, 1);
    const half = await sessionIn(project, 8, 1);
    const busy = await sessionIn(project, 30);
    const listed = await sessionIn(project, 30);
    const held = await sessionIn(project, 30);
    const wanted = await sessionIn(project, 30);
    await thawClaudeSession(store, wanted);
    const notOurs = await written(join(project, "notes.jsonl"), 30);

    const deps = depsOf(store, {
        busy: () => new Set([busy]),
        listed: async () => [listed],
        openFiles: async () => new Set([join(project, `${held}.jsonl`)]),
    });
    const pass = await sweepColdSessions(deps, Date.now());

    expect(pass).toMatchObject({ sessions: 1, files: 2, failed: [] });
    expect(pass.bytesOut).toBeLessThan(pass.bytesIn);
    expect((await readdir(project)).filter((name) => name.endsWith(".zst"))).toEqual([`${cold}.jsonl.zst`]);
    expect(await readdir(join(project, cold, "subagents"))).toEqual(["agent-a9.jsonl.zst"]);
    for (const plain of [fresh, half, busy, listed, held, wanted]) {
        expect(await readdir(project)).toContain(`${plain}.jsonl`);
    }
    expect(await readdir(join(project, half, "subagents"))).toEqual(["agent-a9.jsonl"]);
    expect(await readFile(join(project, "notes.jsonl"), "utf8")).toBe(notOurs);

    // A reader asking for it brings it back, and the next pass leaves it be for the week it was wanted in.
    expect(await thawClaudeSession(store, cold)).toEqual({ thawed: 2, failed: [] });
    expect((await sweepColdSessions(deps, Date.now())).files).toBe(0);
    expect(await readdir(project)).toContain(`${cold}.jsonl`);
});

test("a session goes cold only once every one of its files has sat a week", async () => {
    const { store, project } = await storeWith();
    const id = await sessionIn(project, 0);
    const at = Date.now();
    expect((await sweepColdSessions(depsOf(store), at + COLD_SESSION_MS - DAY_MS)).files).toBe(0);
    expect((await sweepColdSessions(depsOf(store), at + COLD_SESSION_MS + DAY_MS)).files).toBe(1);
    expect(await readdir(project)).toEqual([`${id}.jsonl.zst`]);
});

// /proc as it is: this suite's own process holding the transcript open is enough to keep it plain.
test.skipIf(process.platform !== "linux")("a file some process holds open stays plain until it is closed", async () => {
    const { store, project } = await storeWith();
    const id = await sessionIn(project, 30);
    const { openFiles: _fake, ...deps } = depsOf(store);
    const handle = await open(join(project, `${id}.jsonl`), "r");
    try {
        expect((await sweepColdSessions(deps, Date.now())).files).toBe(0);
    } finally {
        await handle.close();
    }
    expect((await sweepColdSessions(deps, Date.now())).files).toBe(1);
    expect(await readdir(project)).toEqual([`${id}.jsonl.zst`]);
});

test("a pass that cannot read the open files, or the history list, compresses nothing", async () => {
    const { store, project } = await storeWith();
    const id = await sessionIn(project, 30);
    expect(await sweepColdSessions(depsOf(store, { openFiles: async () => undefined }), Date.now())).toMatchObject({
        files: 0,
        held: "the open files could not be read",
    });
    await expect(sweepColdSessions(depsOf(store, { listed: async () => { throw new Error("no store"); } }), Date.now())).rejects.toThrow("no store");
    expect(await readdir(project)).toEqual([`${id}.jsonl`]);
});

test("the chore says what it compressed, and is quiet when there was nothing", async () => {
    const { store, project } = await storeWith();
    await sessionIn(project, 30, 30);
    const info = jest.fn();
    const chore = coldSessionsChore(depsOf(store, { logger: { ...silent, info } }));
    expect(chore).toMatchObject({ name: "cold-sessions", everyMs: 60 * 60_000 });
    await chore.run();
    expect(info.mock.calls).toEqual([[expect.objectContaining({ sessions: 1, files: 2 }), "sessions: compressed Claude sessions nobody touched in a week"]]);
    await chore.run();
    expect(info).toHaveBeenCalledTimes(1);
});

test("a store with no projects yet has nothing to compress", async () => {
    const store = await mkdtemp(join(tmpdir(), "cold-sessions-empty-"));
    roots.push(store);
    expect(await sweepColdSessions(depsOf(store), Date.now())).toEqual({ sessions: 0, files: 0, bytesIn: 0, bytesOut: 0, failed: [] });
});

test("busy sessions are the live turns', and those of conversations that run again by themselves", () => {
    const later = { id: "m1", voice: "person" as const, queuedAt: 1, revision: 1, turn: { prompt: "later", conversationId: "queued" } };
    const entries = new Map([
        ["idle", conversationEntry({ id: "idle", sessionId: "s-idle" })],
        ["running", conversationEntry({ id: "running", sessionId: "s-running" })],
        ["queued", conversationEntry({ id: "queued", sessionId: "s-queued", queue: { items: [later], revision: 1 } })],
        ["resuming", conversationEntry({ id: "resuming", sessionId: "s-resuming" })],
    ]);
    const states = new Map([
        ["idle", idleConversation()],
        ["running", { ...idleConversation(), phase: { kind: "running" as const, startedAt: 1, parked: [], stopping: undefined } }],
        ["resuming", { ...idleConversation(), turn: { ...freshRuntime(), resuming: true } }],
    ]);
    const busy = busySessions({
        agents: { ids: () => [...entries.keys()], entry: (id) => entries.get(id) },
        conversations: {
            liveSessionIds: () => ["s-live"],
            sessionIdOf: (id) => entries.get(id)?.sessionId,
            state: (id) => states.get(id),
            stranded: () => [],
        },
    });
    expect([...busy].toSorted()).toEqual(["s-live", "s-queued", "s-resuming", "s-running"]);
});
