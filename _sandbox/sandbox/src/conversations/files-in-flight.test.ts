import { pino } from "pino";
import { stripTurnPreamble } from "../sessions/vocabulary/prompt-envelope.js";
import { composeWirePrompt } from "../agent/prompt/turn-preamble.js";
import { childActor } from "../auth/principal.js";
import type { IsolatedAgent, PersistedAgent } from "./registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "./registry/agents-store.testing.js";
import { createFilesInFlight, type InFlightReading } from "./files-in-flight.js";

// Pins what a conversation hears about other live conversations changing the files it changes: each pair once, at its
// turn's opening or at its first edit of a shared file, with the other's id and task; never about its own family, and
// never about a private one. And what `agents ls --touching` reads off the same index.

const ROOT = [{ repo: "root", base: "b0" }];
const logger = pino({ level: "silent" });

const conversation = (id: string, title: string, overrides: Partial<IsolatedAgent> = {}): PersistedAgent =>
    isolatedAgent(ROOT, { id, social: { title: { text: title, source: "derived" }, reactions: [] }, ...overrides });

// An index over these records, each reading what `files` says its branch holds now.
const indexOver = (entries: readonly PersistedAgent[], files: Readonly<Partial<Record<string, readonly string[]>>> | Map<string, readonly string[]>) => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const filesOf = (id: string): readonly string[] => (files instanceof Map ? files.get(id) : files[id]) ?? [];
    const reading = (id: string): InFlightReading => ({ paths: filesOf(id), tips: new Map([["root", `tip-${id}`]]) });
    const index = createFilesInFlight({
        agents: { ids: () => [...byId.keys()], entry: (id) => byId.get(id) },
        read: async (entry) => reading(entry.id),
        logger,
    });
    return { index, byId };
};

test("an edit to a file another conversation has in flight is told once, naming it by id and task", async () => {
    const { index } = indexOver([conversation("jet-dewt", "Add the wasm client loop"), conversation("ash-fern", "Fix the shader cache")], {
        "jet-dewt": ["client/src/loop.rs", "client/Cargo.toml"],
    });
    await index.refreshLive();

    const said = index.edited("ash-fern", "client/src/loop.rs");
    expect(said).toContain('`jet-dewt` ("Add the wasm client loop")');
    expect(said).toContain("`client/src/loop.rs`");
    // Never again for the same pair, whichever file: one line, not a flood.
    expect(index.edited("ash-fern", "client/src/loop.rs")).toBeUndefined();
    expect(index.edited("ash-fern", "client/Cargo.toml")).toBeUndefined();
    // The edit itself is now in flight: the other side hears of it at its own next turn.
    expect(index.touching("client/src/loop.rs")).toEqual(
        new Map([
            ["jet-dewt", ["client/src/loop.rs"]],
            ["ash-fern", ["client/src/loop.rs"]],
        ]),
    );
});

test("a file nobody else holds says nothing", async () => {
    const { index } = indexOver([conversation("jet-dewt", "a"), conversation("ash-fern", "b")], { "jet-dewt": ["a.ts"] });
    await index.refreshLive();
    expect(index.edited("ash-fern", "b.ts")).toBeUndefined();
});

test("a turn opens with the conversations changing what it changed, under a header the preamble parser takes back off", async () => {
    const { index } = indexOver([conversation("jet-dewt", "Add the wasm client loop"), conversation("ash-fern", "Fix the shader cache")], {
        "jet-dewt": ["client/src/loop.rs", "client/src/net.rs"],
        "ash-fern": ["client/src/loop.rs", "shaders/cache.rs"],
    });
    await index.refreshLive();

    const note = index.turnNote("ash-fern");
    expect(note?.text).toContain('- `jet-dewt` ("Add the wasm client loop"): `client/src/loop.rs`');
    expect(note?.text).not.toContain("net.rs");
    // A stored prompt read back carries the user's words alone.
    expect(stripTurnPreamble(composeWirePrompt(note === undefined ? [] : [note], "carry on"))).toBe("carry on");
    // Told: the next turn opens without it, and so does an edit to the shared file.
    expect(index.turnNote("ash-fern")).toBeUndefined();
    expect(index.edited("ash-fern", "client/src/loop.rs")).toBeUndefined();
    // The other side has not been told yet.
    expect(index.turnNote("jet-dewt")?.text).toContain("`ash-fern`");
});

test("a parent and the subagents it delegated to are never news to each other; siblings' strangers still are", async () => {
    const parent = conversation("par-ent", "Orchestrate");
    const child = conversation("chi-ld", "Do one part", { identity: { startedBy: childActor("par-ent") } });
    const grandchild = conversation("gra-nd", "Do a smaller part", { identity: { startedBy: childActor("chi-ld") } });
    const stranger = conversation("str-ngr", "Unrelated");
    const { index } = indexOver([parent, child, grandchild, stranger], { "par-ent": ["x.ts"], "chi-ld": ["x.ts"], "str-ngr": ["x.ts"] });
    await index.refreshLive();

    const said = index.edited("gra-nd", "x.ts");
    expect(said).toContain("`str-ngr`");
    expect(said).not.toContain("par-ent");
    expect(said).not.toContain("chi-ld");
    expect(index.overlapsOf("par-ent").map((overlap) => overlap.id)).toEqual(["str-ngr"]);
});

test("a private conversation is never named to another, and an archived one leaves the index at its next reading", async () => {
    const sealed = conversation("pri-vate", "Secret", { seal: { since: 1, readers: [{ email: "a@b.c" }] } });
    const { index, byId } = indexOver([sealed, conversation("pub-lic", "Open"), conversation("ash-fern", "Mine")], {
        "pri-vate": ["x.ts"],
        "pub-lic": ["y.ts"],
    });
    await index.refreshLive();
    expect(index.edited("ash-fern", "x.ts")).toBeUndefined();

    byId.set("pub-lic", { ...byId.get("pub-lic")!, archivedAt: 1 });
    await index.refresh("pub-lic");
    expect(index.holders()).not.toContain("pub-lic");
    expect(index.edited("ash-fern", "y.ts")).toBeUndefined();
});

test("--touching takes a folder for everything under it, and a conversation in the shared tree holds nothing", async () => {
    const shared = conversationEntry({ id: "main-one" });
    const { index } = indexOver([conversation("jet-dewt", "a"), shared], { "jet-dewt": ["client/src/loop.rs", "clientele/x.ts"], "main-one": ["client/a.ts"] });
    await index.refreshLive();
    expect([...index.touching("client/").entries()]).toEqual([["jet-dewt", ["client/src/loop.rs"]]]);
    expect([...index.touching("./client/src/loop.rs").keys()]).toEqual(["jet-dewt"]);
    // A shared-tree conversation still hears who holds a file it edits.
    expect(index.edited("main-one", "client/src/loop.rs")).toContain("`jet-dewt`");
    expect(index.holders()).toEqual(["jet-dewt"]);
});

test("a branch read again with nothing unlanded leaves the index", async () => {
    const files = new Map<string, readonly string[]>([["jet-dewt", ["a.ts"]]]);
    const { index } = indexOver([conversation("jet-dewt", "a")], files);
    await index.refresh("jet-dewt");
    expect(index.pathsOf("jet-dewt")).toEqual(["a.ts"]);
    files.set("jet-dewt", []);
    await index.refresh("jet-dewt");
    expect(index.holders()).toEqual([]);
});
