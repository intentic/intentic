import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResidentEngine, type QueryOutcome, type ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import { retrievalQueryOf, retrieveTurnContext, TURN_CONTEXT_NOTE_HEADER, type TurnContextDeps } from "./turn-context.js";
import { stripTurnPreamble, withTurnPreamble } from "./turn-preamble.js";

/* Pre-injection spends input tokens on every turn it fires on, so what it refuses to fire on is as much of the
 * feature as what it retrieves. These pin the refusals, the gates on a weak answer, and the two properties that
 * keep a bad retrieval from becoming a bad turn: it can never delay one past its deadline, and it can never
 * fail one. */

const answer = `answer: src/agent/turn-plan.ts:74 · confident\n════ src/agent/turn-plan.ts (2) ════\n  74: export const planTurn = async (`;

const outcome = (overrides: Partial<QueryOutcome> = {}): QueryOutcome => ({
    exitCode: 0,
    text: answer,
    result: {
        mode: "q",
        total: 1,
        files: 1,
        shown: 1,
        groups: [{ path: "src/agent/turn-plan.ts", score: 1, hits: [] }],
        freshness: { state: "fresh" },
        truncated: false,
    },
    ...overrides,
});

const warn = vi.fn();
const debug = vi.fn();
const depsOf = (run: ResidentEngine["run"]): TurnContextDeps => ({
    iq: { run },
    logger: { warn, debug } as unknown as Pick<Logger, "warn" | "debug">,
});

const answering = (result: QueryOutcome = outcome()): TurnContextDeps => depsOf(() => Promise.resolve(result));

// The note when there is one, so a test that is about the note's CONTENT does not restate the union each time.
const noteOf = async (deps: TurnContextDeps, prompt: string): Promise<string | undefined> => {
    const result = await retrieveTurnContext(deps, prompt);
    return "note" in result ? result.note : undefined;
};

test("a question about the workspace is what gets retrieved for", () => {
    expect(retrievalQueryOf("how does the daemon decide which runtime serves a turn?")).toBe(
        "how does the daemon decide which runtime serves a turn?",
    );
});

test("a prompt that already names its file is left alone — the model will just open it", () => {
    // Retrieval on top of an anchor the user typed spends tokens pointing at the thing being pointed at.
    expect(retrievalQueryOf("why does turn-plan.ts drop the model?")).toBeUndefined();
    expect(retrievalQueryOf("look at _sandbox/sandbox/src/agent and tell me what runs a turn")).toBeUndefined();
    expect(retrievalQueryOf("read ./src/index.ts first")).toBeUndefined();
});

test("conversational turns are not questions about the code", () => {
    // The index has no idea what "that" was; the model does. Every one of these would retrieve for stopwords.
    expect(retrievalQueryOf("yes please do that")).toBeUndefined();
    expect(retrievalQueryOf("go for it")).toBeUndefined();
    expect(retrievalQueryOf("thanks, looks good")).toBeUndefined();
    expect(retrievalQueryOf("keep going")).toBeUndefined();
    expect(retrievalQueryOf("")).toBeUndefined();
});

/* The gate above used to read "skip when EVERY word is conversational", and one word off the list defeated it —
 * most often a bare number. These are real prompts from one day that each bought a 1.2k-token search of the
 * index for words whose referent was in the previous turn. */
test("a follow-up that points back at the last turn is not a query, however it is spelled", () => {
    expect(retrievalQueryOf("Go for these 2.")).toBeUndefined();
    expect(retrievalQueryOf("Go for 1.")).toBeUndefined();
    expect(retrievalQueryOf(`Go for the "levers".`)).toBeUndefined();
    expect(retrievalQueryOf("Got for all of it.")).toBeUndefined();
});

/* The other half of that gate, and its limit. A resumptive OPENING is not a veto — only a bar — because a
 * message that starts by pointing back and then asks something real is a real question. The cost of keeping
 * those is that pure anaphora with enough words gets through too, and nothing lexical tells the two apart. */
test("a resumptive opener still retrieves once the message carries its own question", () => {
    expect(retrievalQueryOf("Also, how does the scheduler decide which pending automation wakes a sandbox first?")).toBeDefined();
    expect(retrievalQueryOf("how are branch points counted when the hotspots verb ranks a file?")).toBeDefined();
    // An interrogative frame is nearly all stopwords: two content words is a real question and must survive.
    expect(retrievalQueryOf("how do we rotate credentials?")).toBeDefined();
});

test("a slash command is a command, not a question", () => {
    expect(retrievalQueryOf("/review the diff")).toBeUndefined();
});

test("a long prompt is searched by its opening, cut at a word boundary", () => {
    const prompt = `${"why does the retry backoff double ".repeat(20)}end`;
    const query = retrievalQueryOf(prompt);
    expect(query).toBeDefined();
    expect(query!.length).toBeLessThanOrEqual(400);
    // Never mid-identifier: the cut lands on a space in the original, so the last thing the engine sees is a
    // whole word.
    expect(prompt.startsWith(query!)).toBe(true);
    expect(prompt[query!.length]).toBe(" ");
});

test("the note carries the answer, names the query it ran, and says it is not the user's words", async () => {
    const note = await noteOf(answering(), "how does the daemon decide which runtime serves a turn?");
    expect(note).toBeDefined();
    expect(note!.startsWith(TURN_CONTEXT_NOTE_HEADER)).toBe(true);
    expect(note).toContain("Not the user's words");
    expect(note).toContain(`iq "how does the daemon decide which runtime serves a turn?"`);
    expect(note).toContain(answer);
});

// The note is protocol the daemon staples on, so a reopened tab must not redraw it as something the user typed.
test("the preamble round-trips: what restore gives back is the message alone", async () => {
    const prompt = "how does the daemon decide which runtime serves a turn?";
    const note = await noteOf(answering(), prompt);
    expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
});

test("an ineligible prompt never reaches the engine", async () => {
    const run = vi.fn();
    expect(await retrieveTurnContext(depsOf(run as unknown as ResidentEngine["run"]), "go for it")).toEqual({ skipped: "ineligible" });
    expect(run).not.toHaveBeenCalled();
});

/* WHY NOTHING WAS PREPENDED, named rather than merely absent. All four of these used to return the same
 * undefined as a delivered note's opposite, so a turn assigned the treatment and a turn that got it were
 * indistinguishable downstream — which is how the experiment came to report a delta over an arm that was four
 * fifths untreated. */
test("a weak answer is no answer, and says which kind of weak", async () => {
    const question = "how does the daemon decide which runtime serves a turn?";
    expect(await retrieveTurnContext(answering(outcome({ exitCode: 1 })), question)).toEqual({ skipped: "no-hits" });
    const empty = outcome();
    expect(await retrieveTurnContext(answering({ ...empty, result: { ...empty.result, groups: [] } }), question)).toEqual({
        skipped: "no-hits",
    });
    // `building` means the index holds a fraction of the workspace, so its answer would be confidently partial.
    const building = outcome();
    expect(await retrieveTurnContext(answering({ ...building, result: { ...building.result, freshness: { state: "building" } } }), question)).toEqual(
        { skipped: "indexing" },
    );
});

test("a failed retrieval costs the note and nothing else", async () => {
    warn.mockClear();
    const result = await retrieveTurnContext(
        depsOf(() => Promise.reject(new Error("index corrupt"))),
        "how does the daemon decide which runtime serves a turn?",
    );
    // The turn goes on. Killing it over a search this user never asked for would make the feature strictly
    // worse than not having it.
    expect(result).toEqual({ skipped: "failed" });
    expect(warn).toHaveBeenCalledOnce();
});

test("a retrieval that outruns its deadline is abandoned, not waited on", async () => {
    vi.useFakeTimers();
    try {
        let aborted = false;
        const deps = depsOf(
            (_request, signal) =>
                new Promise<QueryOutcome>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => {
                        aborted = true;
                        reject(new Error("aborted"));
                    });
                }),
        );
        const pending = retrieveTurnContext(deps, "how does the daemon decide which runtime serves a turn?");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toEqual({ skipped: "deadline" });
        // The abort still goes out — it releases the half of a query that listens for it (the rg child).
        expect(aborted).toBe(true);
        // An abort is this deadline firing, which is a decision, not a failure worth logging.
        expect(warn).not.toHaveBeenCalledTimes(2);
    } finally {
        vi.useRealTimers();
    }
});

/* The one test that runs the REAL engine, because everything the note is made of comes from outside this
 * module: the renderer's answer capsule, the ranking that decides which file it names, and the exact bytes
 * that then have to survive the preamble round-trip. A stubbed outcome can't fail the way those can — a
 * renderer that one day emits the preamble's own `---` separator would strip the user's message into the
 * daemon's note, and only a real answer would catch it. */
test("against a real index: the note answers the question, and restore still gives the message back", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-context-"));
    // Deliberately not the question's words: "rotate credentials" has to reach `refreshSessionToken`, which is
    // the synonym gap the whole feature exists for.
    writeFileSync(
        join(root, "auth.ts"),
        `export const refreshSessionToken = (token: string): string => {\n    // rotate the credential before it expires\n    return token + "-rotated";\n};\n`,
    );
    writeFileSync(join(root, "paint.ts"), `export const paint = (): string => "blue";\n`);
    const iq = createResidentEngine({ root });
    try {
        await iq.warm();
        const prompt = "how do we rotate credentials?";
        const note = await noteOf({ iq, logger: { warn: () => {}, debug: () => {} } as unknown as Pick<Logger, "warn" | "debug"> }, prompt);
        expect(note).toBeDefined();
        expect(note).toContain("auth.ts:1");
        expect(note).toContain("refreshSessionToken");
        expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
    } finally {
        await iq.close();
    }
});
