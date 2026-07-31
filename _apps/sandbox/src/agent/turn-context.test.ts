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
        shown: 1,
        groups: [{ path: "src/agent/turn-plan.ts", score: 1, hits: [] }],
        freshness: { state: "fresh" },
        truncated: false,
    },
    ...overrides,
});

const warn = vi.fn();
const depsOf = (run: ResidentEngine["run"]): TurnContextDeps => ({ iq: { run }, logger: { warn } as unknown as Pick<Logger, "warn"> });

const answering = (result: QueryOutcome = outcome()): TurnContextDeps => depsOf(() => Promise.resolve(result));

test("a question about the workspace is what gets retrieved for", () => {
    expect(retrievalQueryOf("how does the daemon decide which runtime serves a turn?")).toBe(
        "how does the daemon decide which runtime serves a turn?",
    );
});

test("a prompt that already names its file is left alone — the model will just open it", () => {
    // Retrieval on top of an anchor the user typed spends tokens pointing at the thing being pointed at.
    expect(retrievalQueryOf("why does turn-plan.ts drop the model?")).toBeUndefined();
    expect(retrievalQueryOf("look at _apps/sandbox/src/agent and tell me what runs a turn")).toBeUndefined();
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
    const note = await retrieveTurnContext(answering(), "how does the daemon decide which runtime serves a turn?");
    expect(note).toBeDefined();
    expect(note!.startsWith(TURN_CONTEXT_NOTE_HEADER)).toBe(true);
    expect(note).toContain("Not the user's words");
    expect(note).toContain(`iq "how does the daemon decide which runtime serves a turn?"`);
    expect(note).toContain(answer);
});

// The note is protocol the daemon staples on, so a reopened tab must not redraw it as something the user typed.
test("the preamble round-trips: what restore gives back is the message alone", async () => {
    const prompt = "how does the daemon decide which runtime serves a turn?";
    const note = await retrieveTurnContext(answering(), prompt);
    expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
});

test("an ineligible prompt never reaches the engine", async () => {
    const run = vi.fn();
    expect(await retrieveTurnContext(depsOf(run as unknown as ResidentEngine["run"]), "go for it")).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
});

test("a weak answer is no answer: no hits, or an index that has not caught up with disk yet", async () => {
    const question = "how does the daemon decide which runtime serves a turn?";
    expect(await retrieveTurnContext(answering(outcome({ exitCode: 1 })), question)).toBeUndefined();
    const empty = outcome();
    expect(await retrieveTurnContext(answering({ ...empty, result: { ...empty.result, groups: [] } }), question)).toBeUndefined();
    // `building` means the index holds a fraction of the workspace, so its answer would be confidently partial.
    const building = outcome();
    expect(
        await retrieveTurnContext(answering({ ...building, result: { ...building.result, freshness: { state: "building" } } }), question),
    ).toBeUndefined();
});

test("a failed retrieval costs the note and nothing else", async () => {
    warn.mockClear();
    const note = await retrieveTurnContext(
        depsOf(() => Promise.reject(new Error("index corrupt"))),
        "how does the daemon decide which runtime serves a turn?",
    );
    // The turn goes on. Killing it over a search this user never asked for would make the feature strictly
    // worse than not having it.
    expect(note).toBeUndefined();
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
        expect(await pending).toBeUndefined();
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
        const note = await retrieveTurnContext({ iq, logger: { warn: () => {} } as unknown as Pick<Logger, "warn"> }, prompt);
        expect(note).toBeDefined();
        expect(note).toContain("auth.ts:1");
        expect(note).toContain("refreshSessionToken");
        expect(stripTurnPreamble(withTurnPreamble([note!], prompt))).toBe(prompt);
    } finally {
        await iq.close();
    }
});
