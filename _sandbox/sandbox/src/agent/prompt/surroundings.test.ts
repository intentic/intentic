import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { CLAUDE_CODE_RUNTIME, SURROUNDINGS_CLEARED, SURROUNDINGS_TITLE, guidanceBlock, type GuidanceFacts } from "./guidance.js";
import { recordSurroundingsSaid, surroundingsNote } from "./surroundings.js";

// The note under a stable prompt: what moves between turns, said when it moved and only then.

// The holdings a daemon's conversations keep in memory, fresh per call: a new one is a daemon that just restarted.
const fleet = () => memoryFleet().conversations;

const QUIET = { runtime: CLAUDE_CODE_RUNTIME, unattended: false, hostDevices: undefined, ownBrowsers: undefined, ownPhones: undefined } as const;
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

const LOOP: GuidanceFacts = {
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

// The owner's night (agent/night): said as it begins, in place of the unwatched note, and in the words of what a
// question gets then.
test("the owner's night is said as it begins, and says what a question gets", () => {
    const actors = fleet();
    const decide = surroundingsNote(actors, "c1", FRESH, { ...UNWATCHED, night: { questions: "decide", until: "07:00" } });
    expect(decide?.text).toContain("their night hours run until 07:00");
    expect(decide?.text).toContain("Decided while you slept");
    // Which one waits on its card until the owner answers is no longer what this turn is told.
    expect(decide?.text).not.toContain("Nobody is watching this turn");
    sent(actors, "c1", decide, true);

    const defer = surroundingsNote(actors, "c1", RESUMED, { ...UNWATCHED, night: { questions: "defer", until: "07:00" } });
    expect(defer?.text).toContain("Do not decide what is genuinely theirs either");
    expect(defer?.text).toContain("Do not enter plan mode");
    sent(actors, "c1", defer);

    // Morning: the night is over, and the turn is told so.
    expect(surroundingsNote(actors, "c1", RESUMED, UNWATCHED)?.text).toContain("Nobody is watching this turn");
});

// While this sandbox is full and a runner is calm, the turn hears where its work can go; on a quiet fleet, nothing.
test("a full sandbox is said with the machines that have room, and the spawn tool only where the turn holds it", () => {
    const pressed = { ...QUIET, fleetPressure: { roomy: ["omen", "z440"] } };
    const note = surroundingsNote(fleet(), "c1", FRESH, pressed)?.text ?? "";
    expect(note).toContain("This sandbox is full right now (memory or CPU), while omen and z440 have room.");
    expect(note).toContain("`mcp__subagents__spawn`");
    expect(surroundingsNote(fleet(), "c1", FRESH, { ...pressed, subagents: false })?.text).not.toContain("spawn");
    expect(surroundingsNote(fleet(), "c1", FRESH, QUIET)).toBeUndefined();
    // Said once, then cleared in words that say the sandbox has room again.
    const actors = fleet();
    sent(actors, "c2", surroundingsNote(actors, "c2", FRESH, pressed), true);
    expect(surroundingsNote(actors, "c2", RESUMED, QUIET)?.text).toContain("this sandbox is not full");
});
