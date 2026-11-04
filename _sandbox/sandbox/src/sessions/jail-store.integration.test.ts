import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { enterJailStore, leaveJailStore, sessionPaths } from "./jail-store.js";
import { claudeStoreOf, jailStoreDir, sessionsDir } from "./session-store.js";

// The move of a conversation's Claude sessions into the jail's store of its own and back, on real directories: what the
// daemon's readers find (claudeStoreOf) must follow every step, and another conversation's files must never move.

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SESSION = "5d0b6a0e-1111-4222-8333-944445555666";
const OTHER = "7a1c2b3d-aaaa-4bbb-8ccc-9ddddeeeeeee";

const tree = async () => {
    const root = await mkdtemp(join(tmpdir(), "jail-store-"));
    roots.push(root);
    const workspace = join(root, "work");
    const history = join(root, "history");
    const shared = join(workspace, STATE_DIR, "records", "sessions", "claude");
    const put = async (rel: string, text: string): Promise<void> => {
        await mkdir(join(shared, rel, ".."), { recursive: true });
        await writeFile(join(shared, rel), text);
    };
    for (const id of [SESSION, OTHER]) {
        await put(`projects/-work/${id}.jsonl`, `{"sessionId":"${id}"}\n`);
        await put(`projects/-work/${id}/subagents/agent-1.jsonl`, "{}\n");
        await put(`todos/${id}-agent-${id}.json`, "[]");
        await put(`tasks/${id}/1.json`, "{}");
    }
    return { workspace, history, shared };
};

const owner = { id: "brave-fjord-f64y", sessionId: SESSION, identity: {} };

test("a session's own files are its transcript, the directory beside it, its checklists and its task list", async () => {
    const { shared } = await tree();
    expect((await sessionPaths(shared, SESSION)).toSorted()).toEqual(
        [`projects/-work/${SESSION}.jsonl`, `projects/-work/${SESSION}`, `todos/${SESSION}-agent-${SESSION}.json`, `tasks/${SESSION}`].toSorted(),
    );
    expect(await sessionPaths(shared, "../escape")).toEqual([]);
});

test("into the jail the current session moves to the conversation's own store, and the daemon reads it there", async () => {
    const { workspace, history, shared } = await tree();
    expect(claudeStoreOf(workspace, history, owner)).toBe(shared);
    const store = await enterJailStore(workspace, history, owner);
    expect(store).toBe(jailStoreDir(history, owner.id));
    expect(claudeStoreOf(workspace, history, owner)).toBe(store);
    expect(await readFile(join(store, "projects", "-work", `${SESSION}.jsonl`), "utf8")).toBe(`{"sessionId":"${SESSION}"}\n`);
    expect(await readdir(join(store, "projects", "-work", SESSION, "subagents"))).toEqual(["agent-1.jsonl"]);
    // Gone from the shared store, where every jailed turn's view is covered anyway; the other conversation's untouched.
    expect(await sessionPaths(shared, SESSION)).toEqual([]);
    expect((await sessionPaths(shared, OTHER)).length).toBe(4);
    // Once is enough: a second jailed turn finds its store and moves nothing.
    await writeFile(join(store, "projects", "-work", `${SESSION}.jsonl`), "newer\n");
    await enterJailStore(workspace, history, owner);
    expect(await readFile(join(store, "projects", "-work", `${SESSION}.jsonl`), "utf8")).toBe("newer\n");
});

test("out of the jail everything the store holds goes back to the shared one, and the daemon reads it there again", async () => {
    const { workspace, history, shared } = await tree();
    const store = await enterJailStore(workspace, history, owner);
    await writeFile(join(store, "projects", "-work", `${SESSION}.jsonl`), "written in the jail\n");
    await leaveJailStore(workspace, history, owner);
    expect(claudeStoreOf(workspace, history, owner)).toBe(shared);
    expect(await readFile(join(shared, "projects", "-work", `${SESSION}.jsonl`), "utf8")).toBe("written in the jail\n");
    expect(await readdir(join(history, "conversations", owner.id))).toEqual([]);
});

test("a conversation with no session yet gets an empty store of its own", async () => {
    const { workspace, history, shared } = await tree();
    const store = await enterJailStore(workspace, history, { id: owner.id, identity: {} });
    expect((await readdir(join(store, "projects"))).length).toBe(0);
    expect((await sessionPaths(shared, SESSION)).length).toBe(4);
});

test("a fenced conversation keeps its own store for life and is never moved", async () => {
    const { workspace, history, shared } = await tree();
    const fenced = { ...owner, identity: { areas: ["support"] } };
    expect(claudeStoreOf(workspace, history, fenced)).toBe(sessionsDir(history, owner.id));
    await enterJailStore(workspace, history, fenced);
    await leaveJailStore(workspace, history, fenced);
    expect((await sessionPaths(shared, SESSION)).length).toBe(4);
    expect(claudeStoreOf(workspace, history, fenced)).toBe(sessionsDir(history, owner.id));
});
