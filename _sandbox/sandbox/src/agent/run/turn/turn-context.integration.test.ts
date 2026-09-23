import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResidentEngine, type QueryOutcome, type ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { retrievalEvidenceOf, retrieveTurnContext, TURN_CONTEXT_NOTE_HEADER, type TurnContextDeps } from "./turn-context.js";
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

const warn = jest.fn();
const debug = jest.fn();
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

const queryOf = (prompt: string): string | undefined => retrievalEvidenceOf(prompt)?.query;

test("a question about the workspace is what gets retrieved for", () => {
    expect(queryOf("how does the daemon decide which runtime serves a turn?")).toBe("how does the daemon decide which runtime serves a turn?");
});

// A named file used to make the whole turn ineligible. It is the strongest evidence a message can carry — the user
// already localized the work — so it is resolved instead of spent, and the expensive fused query is dropped.
test("a prompt that names its file resolves that file and skips the fused query", () => {
    expect(retrievalEvidenceOf("why does turn-plan.ts drop the model?")).toEqual({
        paths: ["turn-plan.ts"],
        literals: [],
        query: undefined,
    });
    expect(retrievalEvidenceOf("read ./src/index.ts first")).toMatchObject({ paths: ["./src/index.ts"], query: undefined });
    // A `path:line` keeps its line: that is the tightest anchor the message has.
    expect(retrievalEvidenceOf("src/agent/turn-plan.ts:74 looks wrong")).toMatchObject({ paths: ["src/agent/turn-plan.ts:74"] });
    // The bare filename inside a fuller path is the same evidence twice, and does not become a second lookup.
    expect(retrievalEvidenceOf("check src/agent/turn-plan.ts please")).toMatchObject({ paths: ["src/agent/turn-plan.ts"] });
});

// A directory is not a file with a shape to outline, so it stays a question for the fused pipeline.
test("a directory reference is not a path lookup", () => {
    expect(retrievalEvidenceOf("look at _sandbox/sandbox/src/agent and tell me what runs a turn")).toMatchObject({
        paths: [],
        query: expect.any(String),
    });
});

// A stack trace is the same class as a named file: the frame says where the failure came through.
test("a traceback frame resolves to the file and line it names", () => {
    expect(retrievalEvidenceOf(`Traceback:\n  File "app/models.py", line 42, in save`)).toMatchObject({ paths: ["app/models.py:42"] });
    expect(retrievalEvidenceOf("TypeError\n    at save (src/models.ts:42:7)")).toMatchObject({ paths: ["src/models.ts:42"] });
});

// Quoted code is grepped verbatim: an error string either occurs in the source or it does not, and the fused pipeline
// dilutes it against the prose around it.
test("quoted code becomes an exact match, quoted English does not", () => {
    expect(retrievalEvidenceOf("where does `createIgnoreScope` get called?")).toMatchObject({ literals: ["createIgnoreScope"] });
    expect(retrievalEvidenceOf('the log says "Cannot read properties of undefined" somewhere')).toMatchObject({
        literals: ["Cannot read properties of undefined"],
    });
    // A quoted ordinary word is a phrase, not a symbol; grepping it costs a call and returns noise.
    expect(retrievalEvidenceOf(`Go for the "levers".`)).toBeUndefined();
});

test("conversational turns are not questions about the code", () => {
    // The index can't resolve 'that'; retrieving here would search on stopwords alone.
    expect(retrievalEvidenceOf("yes please do that")).toBeUndefined();
    expect(retrievalEvidenceOf("go for it")).toBeUndefined();
    expect(retrievalEvidenceOf("thanks, looks good")).toBeUndefined();
    expect(retrievalEvidenceOf("keep going")).toBeUndefined();
    expect(retrievalEvidenceOf("")).toBeUndefined();
});

// The old gate skipped only when every word was conversational; one off-list word (often a bare number) defeated it and
// still triggered a full-index search.
test("a follow-up that points back at the last turn is not a query, however it is spelled", () => {
    expect(retrievalEvidenceOf("Go for these 2.")).toBeUndefined();
    expect(retrievalEvidenceOf("Go for 1.")).toBeUndefined();
    expect(retrievalEvidenceOf("Got for all of it.")).toBeUndefined();
});

// A resumptive opening only bars retrieval if nothing else follows; long pure anaphora can still slip through since
// nothing lexical tells the two apart.
test("a resumptive opener still retrieves once the message carries its own question", () => {
    expect(queryOf("Also, how does the scheduler decide which pending automation wakes a sandbox first?")).toEqual(expect.any(String));
    expect(queryOf("how are branch points counted when the hotspots verb ranks a file?")).toEqual(expect.any(String));
    // An interrogative frame is nearly all stopwords: two content words is a real question and must survive.
    expect(queryOf("how do we rotate credentials?")).toEqual(expect.any(String));
});

test("a slash command is a command, not a question", () => {
    expect(retrievalEvidenceOf("/review the diff")).toBeUndefined();
});

test("a long prompt is searched by its opening, cut at a word boundary", () => {
    const prompt = `${"why does the retry backoff double ".repeat(20)}end`;
    const query = queryOf(prompt);
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
    const run = jest.fn();
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
    // Do not fail a turn because its optional search was unrequested.
    expect(result).toMatchObject({ skipped: "failed" });
    expect(warn).toHaveBeenCalledTimes(1);
});

test("a retrieval that outruns its deadline is abandoned, not waited on", async () => {
    jest.useFakeTimers();
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
        await advanceTimersByTimeAsync(3_000);
        expect(await pending).toEqual({ skipped: "deadline", durationMs: 3_000 });
        // The abort still goes out: it releases the half of a query that listens for it (the rg child).
        expect(aborted).toBe(true);
        // An abort here is the deadline firing by design, not a failure worth a warn log.
        expect(warn).not.toHaveBeenCalledTimes(2);
    } finally {
        jest.useRealTimers();
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

// The classes are additive and the convergence lead is computed off what they actually returned, so both need a real
// index to mean anything.
test("against a real index: a named file and a quoted symbol are both resolved, and agreement leads the note", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-context-"));
    writeFileSync(
        join(root, "auth.ts"),
        `export const refreshSessionToken = (token: string): string => {\n    // rotate the credential before it expires\n    return token + "-rotated";\n};\n`,
    );
    writeFileSync(join(root, "paint.ts"), `export const paint = (): string => "blue";\n`);
    const iq = createResidentEngine({ root });
    const deps = { iq, logger: { warn: () => {}, debug: () => {} } as unknown as Pick<Logger, "warn" | "debug"> };
    try {
        await iq.warm();
        // Both classes point at auth.ts, which is exactly the case the convergence lead exists for.
        const both = await retrieveTurnContext(deps, "in auth.ts, why does `refreshSessionToken` return early?");
        expect(both).toMatchObject({ strategies: ["paths", "literals"] });
        const note = "note" in both ? both.note : "";
        expect(note).toContain("iq outline auth.ts");
        expect(note).toContain(`iq find "refreshSessionToken" --literal`);
        expect(note).toContain("More than one of those landed on `auth.ts`");
        // The fused query is not run once a path localized the turn: it is the expensive call and the file is known.
        expect(note).not.toContain("read as a question");

        // A file named with no quoted code is the path class alone.
        const pathOnly = await retrieveTurnContext(deps, "what does paint.ts do?");
        expect(pathOnly).toMatchObject({ strategies: ["paths"], paths: ["paint.ts"] });
    } finally {
        await iq.close();
    }
});
