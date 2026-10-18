import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { SURROUNDINGS_CLEARED, SURROUNDINGS_TITLE, guidanceBlock, type LoopFacts } from "./guidance.js";
import { recordSurroundingsSaid, surroundingsNote } from "./surroundings.js";

// The note under a stable prompt: what moves between turns, said when it moved and only then.

// The holdings a daemon's conversations keep in memory, fresh per call: a new one is a daemon that just restarted.
const fleet = () => memoryFleet().conversations;

const QUIET = { unattended: false, hostDevices: undefined, ownBrowsers: undefined, ownPhones: undefined } as const;
const UNWATCHED = { ...QUIET, unattended: true } as const;
const DEVICES = { ...QUIET, hostDevices: { ids: ["laptop"] } } as const;
const RESUMED = { fresh: false } as const;
const FRESH = { fresh: true } as const;

// A turn's note as the dispatch files it, so the next turn reads what this one was actually sent.
const sent = (actors: ReturnType<typeof fleet>, conversationId: string, note: ReturnType<typeof surroundingsNote>, fresh = false): void => {
    recordSurroundingsSaid(actors, conversationId, { notes: note === undefined ? [] : [note], fresh });
};

test("a fresh session with nothing that moves is told nothing", () => {
    expect(surroundingsNote(fleet(), "c1", FRESH, QUIET)).toBeUndefined();
});

test("what moves is said once, then not again while it holds", () => {
    const actors = fleet();
    const first = surroundingsNote(actors, "c1", FRESH, UNWATCHED);
    expect(first?.title).toBe(SURROUNDINGS_TITLE);
    expect(first?.text).toContain("Nobody is watching this turn");
    sent(actors, "c1", first, true);

    expect(surroundingsNote(actors, "c1", RESUMED, UNWATCHED)).toBeUndefined();
});

test("a change is said, and so is the moment nothing holds any more", () => {
    const actors = fleet();
    sent(actors, "c1", surroundingsNote(actors, "c1", FRESH, UNWATCHED), true);

    const moved = surroundingsNote(actors, "c1", RESUMED, DEVICES);
    expect(moved?.text).toContain("`laptop`");
    expect(moved?.text).not.toContain("Nobody is watching");
    sent(actors, "c1", moved);

    const cleared = surroundingsNote(actors, "c1", RESUMED, QUIET);
    expect(cleared?.text).toBe(SURROUNDINGS_CLEARED);
    sent(actors, "c1", cleared);
    expect(surroundingsNote(actors, "c1", RESUMED, QUIET)).toBeUndefined();
});

test("a session the CLI compacted, or a daemon that restarted, is told again", () => {
    const actors = fleet();
    sent(actors, "c1", surroundingsNote(actors, "c1", FRESH, DEVICES), true);

    expect(surroundingsNote(actors, "c1", FRESH, DEVICES)?.text).toContain("`laptop`");
    expect(surroundingsNote(fleet(), "c1", RESUMED, DEVICES)?.text).toContain("`laptop`");
});

test("one conversation's note is not another's", () => {
    const actors = fleet();
    sent(actors, "c1", surroundingsNote(actors, "c1", FRESH, DEVICES), true);

    expect(surroundingsNote(actors, "c2", RESUMED, DEVICES)?.title).toBe(SURROUNDINGS_TITLE);
});

const LOOP: LoopFacts = {
    ...UNWATCHED,
    hostDevices: { ids: ["laptop"] },
    browserOutputDir: undefined,
    browserAccounts: false,
    desktop: false,
    diagnostics: false,
    terminal: false,
};

test("a stable block leaves out exactly what the note says, and nothing else", () => {
    const full = guidanceBlock(LOOP, "rg");
    const stable = guidanceBlock(LOOP, "rg", true);
    const note = surroundingsNote(fleet(), "c1", FRESH, LOOP)?.text ?? "";

    expect(full).toContain("Nobody is watching this turn");
    expect(stable).not.toContain("Nobody is watching this turn");
    expect(stable).not.toContain("`laptop`");
    // Every paragraph the stable block dropped is in the note, so a stable turn is told the same things.
    const dropped = full.split("\n\n").filter((paragraph) => !stable.split("\n\n").includes(paragraph));
    expect(dropped.length).toBeGreaterThan(0);
    for (const paragraph of dropped) {
        expect(note).toContain(paragraph);
    }
});
