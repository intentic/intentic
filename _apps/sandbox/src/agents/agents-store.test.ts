import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileAgentsStore, type PersistedAgent } from "./agents-store.js";

// The store guards the fleet's ONLY record — these tests are about the ways a bad file used to become an
// erased one: load answering `[]` with the file still in the write path, and a torn write leaving a prefix.

const entry = (id: string): PersistedAgent => ({
    id,
    branch: `agent/${id}`,
    provider: "claude",
    harness: "native",
    repos: [{ repo: "root", base: "a".repeat(40) }],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
});

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "agents-store-"));

describe("fileAgentsStore", () => {
    it("round-trips a roster", async () => {
        const store = fileAgentsStore(join(await dir(), "agents.json"));
        await store.save([entry("c1"), entry("c2")]);
        expect((await store.load()).map((agent) => agent.id)).toEqual(["c1", "c2"]);
    });

    it("an absent file reads as a fresh sandbox", async () => {
        const store = fileAgentsStore(join(await dir(), "agents.json"));
        expect(await store.load()).toEqual([]);
    });

    it("saves atomically — no partial file is ever the file", async () => {
        const root = await dir();
        const path = join(root, "agents.json");
        const store = fileAgentsStore(path);
        await store.save([entry("c1")]);
        await store.save([entry("c1"), entry("c2")]);
        // The tmp staging file must not linger as a sibling the next boot could trip on.
        expect((await readdir(root)).toSorted()).toEqual(["agents.json"]);
        expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(2);
    });

    it("sets an unparseable file aside instead of leaving it to be overwritten", async () => {
        const root = await dir();
        const path = join(root, "agents.json");
        const torn = `[\n  {"id": "c1", "branch": "agent/c1"`; // a truncated write
        await writeFile(path, torn);
        const store = fileAgentsStore(path);
        expect(await store.load()).toEqual([]);
        // The bytes survive out of the write path — a later save must not destroy the only copy.
        expect(await readFile(`${path}.corrupt`, "utf8")).toBe(torn);
        await store.save([entry("c2")]);
        expect(await readFile(`${path}.corrupt`, "utf8")).toBe(torn);
        expect((await store.load()).map((agent) => agent.id)).toEqual(["c2"]);
    });

    it("one invalid entry costs that entry, not the roster", async () => {
        const root = await dir();
        const path = join(root, "agents.json");
        await writeFile(path, JSON.stringify([entry("c1"), { id: "half-a-row" }, entry("c3")]));
        const store = fileAgentsStore(path);
        expect((await store.load()).map((agent) => agent.id)).toEqual(["c1", "c3"]);
    });

    it("a non-array file is set aside like any other unreadable one", async () => {
        const root = await dir();
        const path = join(root, "agents.json");
        await writeFile(path, JSON.stringify({ agents: [] }));
        const store = fileAgentsStore(path);
        expect(await store.load()).toEqual([]);
        expect(await readFile(`${path}.corrupt`, "utf8")).toBe(JSON.stringify({ agents: [] }));
    });
});
