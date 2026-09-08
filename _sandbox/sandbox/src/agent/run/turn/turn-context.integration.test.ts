import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResidentEngine, type QueryOutcome, type ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import { retrievalQueryOf, retrieveTurnContext, TURN_CONTEXT_NOTE_HEADER, type TurnContextDeps } from "./turn-context.js";
import { stripTurnPreamble, withTurnPreamble } from "../../prompt/turn-preamble.js";

// Pins pre-injection's refusals and its two guarantees: a bad retrieval never delays a turn past its deadline and never
// fails one.

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

// Returns the note when present, so tests about its content skip restating the union.
const noteOf = async (deps: TurnContextDeps, prompt: string): Promise<string | undefined> => {
    const result = await retrieveTurnContext(deps, prompt);
    return "note" in result ? result.note : undefined;
};

test("a question about the workspace is what gets retrieved for", () => {
    expect(retrievalQueryOf("how does the daemon decide which runtime serves a turn?")).toBe(
        "how does the daemon decide which runtime serves a turn?",
    );
});

test("a prompt that already names its file is left alone: the model will just open it", () => {
    // An anchor the user already typed needs no retrieval pointing back at it.
    expect(retrievalQueryOf("why does turn-plan.ts drop the model?")).toBeUndefined();
    expect(retrievalQueryOf("look at _sandbox/sandbox/src/agent and tell me what runs a turn")).toBeUndefined();
    expect(retrievalQueryOf("read ./src/index.ts first")).toBeUndefined();
});

test("conversational turns are not questions about the code", () => {
    // The index can't resolve 'that'; retrieving here would search on stopwords alone.
    expect(retrievalQueryOf("yes please do that")).toBeUndefined();
    expect(retrievalQueryOf("go for it")).toBeUndefined();
    expect(retrievalQueryOf("thanks, looks good")).toBeUndefined();
    expect(retrievalQueryOf("keep going")).toBeUndefined();
    expect(retrievalQueryOf("")).toBeUndefined();
});

// The old gate skipped only when every word was conversational; one off-list word (often a bare number) defeated it and
// still triggered a full-index search.
test("a follow-up that points back at the last turn is not a query, however it is spelled", () => {
    expect(retrievalQueryOf("Go for these 2.")).toBeUndefined();
    expect(retrievalQueryOf("Go for 1.")).toBeUndefined();
    expect(retrievalQueryOf(`Go for the "levers".`)).toBeUndefined();
    expect(retrievalQueryOf("Got for all of it.")).toBeUndefined();
});

// A resumptive opening only bars retrieval if nothing else follows; long pure anaphora can still slip through since
// nothing lexical tells the two apart.
test("a resumptive opener still retrieves once the message carries its own question", () => {
    expect(retrievalQueryOf("Also, how does the scheduler decide which pending automation wakes a sandbox first?")).toEqual(expect.any(String));
    expect(retrievalQueryOf("how are branch points counted when the hotspots verb ranks a file?")).toEqual(expect.any(String));
    // An interrogative frame is nearly all stopwords: two content words is a real question and must survive.
    expect(retrievalQueryOf("how do we rotate credentials?")).toEqual(expect.any(String));
});

test("a slash command is a command, not a question", () => {
    expect(retrievalQueryOf("/review the diff")).toBeUndefined();
});

test("a long prompt is searched by its opening, cut at a word boundary", () => {
    const prompt = `${"why does the retry backoff double ".repeat(20)}end`;
    const query = retrievalQueryOf(prompt);
    expect(query!.length).toBeLessThanOrEqual(400);
    // Cuts on a space in the original, never mid-identifier.
    expect(prompt.startsWith(query!)).toBe(true);
    expect(prompt[query!.length]).toBe(" ");
});

test("the note carries the answer, names the query it ran, and says it is not the user's words", async () => {
    const note = await noteOf(answering(), "how does the daemon decide which runtime serves a turn?");
    expect(note!.startsWith(TURN_CONTEXT_NOTE_HEADER)).toBe(true);
    expect(note).toContain("Not the user's words");
    expect(note).toContain(`iq "how does the daemon decide which runtime serves a turn?"`);
    expect(note).toContain(answer);
});

// The note is protocol the daemon staples on; a reopened tab must not redraw it as something the user typed.
test("the preamble round-trips: what restore gives back is the message alone", async () => {
    const prompt = "how does the daemon decide which runtime serves a turn?";
    const note = await noteOf(answering(), prompt);
    expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
});

// No pipeline stage is skipped: both model stages already run on the engine's query worker, so narrowing here would
// only cost accuracy for no time saved.
test("the pre-injected query holds no stage back: the engine runs its full pipeline", async () => {
    const seen: Parameters<ResidentEngine["run"]>[0][] = [];
    const deps = depsOf((request) => {
        seen.push(request);
        return Promise.resolve(outcome());
    });
    await retrieveTurnContext(deps, "how do we rotate credentials?");
    expect(seen[0]?.features).toBeUndefined();
});

test("an ineligible prompt never reaches the engine", async () => {
    const run = vi.fn();
    expect(await retrieveTurnContext(depsOf(run as unknown as ResidentEngine["run"]), "go for it")).toMatchObject({ skipped: "ineligible" });
    expect(run).not.toHaveBeenCalled();
});

// Each refusal returns its own `skipped` reason rather than a bare undefined, so a treated turn is distinguishable from
// one that never qualified.
test("a weak answer is no answer, and says which kind of weak", async () => {
    const question = "how does the daemon decide which runtime serves a turn?";
    expect(await retrieveTurnContext(answering(outcome({ exitCode: 1 })), question)).toMatchObject({ skipped: "no-hits" });
    const empty = outcome();
    expect(await retrieveTurnContext(answering({ ...empty, result: { ...empty.result, groups: [] } }), question)).toMatchObject({
        skipped: "no-hits",
    });
    // `building` means the index holds a fraction of the workspace, so its answer would be confidently partial.
    const building = outcome();
    expect(
        await retrieveTurnContext(answering({ ...building, result: { ...building.result, freshness: { state: "building" } } }), question),
    ).toMatchObject({ skipped: "indexing" });
});

test("a failed retrieval costs the note and nothing else", async () => {
    warn.mockClear();
    const result = await retrieveTurnContext(
        depsOf(() => Promise.reject(new Error("index corrupt"))),
        "how does the daemon decide which runtime serves a turn?",
    );
    // The turn proceeds regardless: failing it over an unrequested search would make the feature worse than not having
    // it.
    expect(result).toMatchObject({ skipped: "failed" });
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
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await pending).toEqual({ skipped: "deadline", durationMs: 3_000 });
        // The abort still goes out: it releases the half of a query that listens for it (the rg child).
        expect(aborted).toBe(true);
        // An abort here is the deadline firing by design, not a failure worth a warn log.
        expect(warn).not.toHaveBeenCalledTimes(2);
    } finally {
        vi.useRealTimers();
    }
});

// The one test against the real engine: the note's bytes (renderer output, ranking, preamble round-trip) can't be faked
// with a stubbed outcome.
test("against a real index: the note answers the question, and restore still gives the message back", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-context-"));
    // Deliberately not the question's words: "rotate credentials" has to reach `refreshSessionToken`, the synonym gap
    // the feature exists for.
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
        expect(note).toEqual(expect.any(String));
        expect(note).toContain("auth.ts:1");
        expect(note).toContain("refreshSessionToken");
        expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
    } finally {
        await iq.close();
    }
});
