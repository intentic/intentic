import type { ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";

// Runs the user's prompt through the resident iq engine before the turn starts and prepends the ranked answer, so the
// model opens with path:line anchors instead of spending tool calls finding them. Rides the user message, not a
// callable tool or the system prompt: cheaper than a round trip and keeps the cached system prefix byte-stable.

export const TURN_CONTEXT_NOTE_HEADER = "## Retrieved workspace context";

// Hard token budget for the note; the renderer drops trailing groups to stay under it.
const CONTEXT_BUDGET_TOKENS = 1200;

// Only the prompt's opening is searched; more terms past that dilute the query for both BM25 and the embedder.
const QUERY_MAX_CHARS = 400;

// Backstop only, not a scheduling budget: past this the turn proceeds without the note and the query is abandoned
// mid-flight.
const RETRIEVAL_DEADLINE_MS = 3_000;

// No pipeline stage is skipped: the semantic scan and the cross-encoder both run on the engine's own query worker
// thread, not the daemon's.

// Words with no search intent; kept minimal so a real query never loses a word it needs.
const CONVERSATIONAL = new Set(
    "a about again all also am an and any are as at be been but by can cool could did do does doing done fine for from go going good great has have how i if in is it its just keep let like looks make me more my need next no not now of ok okay on one only or our out over please pls same should so some sounds sure than thanks that the their them then there these they this those thx to too try up us was we well were what when where which who why will with would yeah yes yep you your yours".split(
        " ",
    ),
);

// At least one content word is required, not raised higher: an interrogative prompt is itself mostly stopwords.
const MIN_CONTENT_WORDS = 1;

// A resumptive opener needs a few content words of its own; nothing lexical separates that from long pure anaphora,
// which still gets through.
const RESUMPTIVE_OPENER =
    /^\s*(?:go (?:for|ahead|on)|got for|continue|carry on|keep going|proceed|do (?:it|that|both|this)|apply|fix (?:it|that|them|these|those)|try again|redo|instead|also|same|and |but |that |those |these |it )/i;
const MIN_RESUMPTIVE_CONTENT_WORDS = 3;

// A bare number carries no search intent; it usually refers to something the previous turn listed.
const isContentWord = (word: string): boolean => !CONVERSATIONAL.has(word) && !/^\d+$/.test(word);

// Either a slash-bearing path or a bare filename with a source-ish extension: both mean the user already located the
// file.
const EXPLICIT_PATH = /(^|\s)[\w.~-]*\/[\w./-]+/;
const EXPLICIT_FILE =
    /(^|\s)[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|rb|php|cs|kt|swift|scala|c|h|cpp|sql|sh|css|scss|html|json|ya?ml|toml|md)\b/i;

// Every gate here is lexical: this runs before the turn, with no model call available to judge whether one needs help.
// Returns the prompt's opening, trimmed, so the note can echo the query it ran.
export const retrievalQueryOf = (prompt: string): string | undefined => {
    const text = prompt.trim();
    // A slash command is a command to the CLI, not a question about the workspace.
    if (text === "" || text.startsWith("/")) {
        return undefined;
    }
    if (EXPLICIT_PATH.test(text) || EXPLICIT_FILE.test(text)) {
        return undefined;
    }
    const content = (text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) ?? []).filter(isContentWord);
    if (content.length < MIN_CONTENT_WORDS) {
        return undefined;
    }
    if (RESUMPTIVE_OPENER.test(text) && content.length < MIN_RESUMPTIVE_CONTENT_WORDS) {
        return undefined;
    }
    if (text.length <= QUERY_MAX_CHARS) {
        return text;
    }
    // Cuts at the last word boundary inside the cap, so the query never ends mid-identifier.
    const head = text.slice(0, QUERY_MAX_CHARS);
    const lastSpace = head.lastIndexOf(" ");
    return lastSpace > 0 ? head.slice(0, lastSpace) : head;
};

const turnContextNote = (query: string, answer: string): string =>
    `${TURN_CONTEXT_NOTE_HEADER}\n\n` +
    `Not the user's words. Before this turn the daemon searched this workspace for the message below and pasted ` +
    `the ranked answer here, so the first search is already paid for. It ran \`iq "${query}"\`.\n\n` +
    `Treat it as a starting point, not an answer: it may have missed the question entirely, the anchors are ` +
    `positions to read rather than facts, and your own search tools are still the way to check.\n\n` +
    `${answer.trim()}`;

export interface TurnContextDeps {
    readonly iq: Pick<ResidentEngine, "run">;
    readonly logger: Pick<Logger, "warn" | "debug">;
}

// Named rather than silent, so a turn where nothing fired is distinguishable from one that succeeded. `ineligible`
// fails a gate above; the rest are retrieval itself declining.
export type TurnContextSkip = "ineligible" | "deadline" | "indexing" | "no-hits" | "failed";

// A union, not an optional pair: exactly one side is always present, so a caller can't read both note and skip as
// absent.
export type TurnContextOutcome =
    { readonly note: string; readonly durationMs: number } | { readonly skipped: TurnContextSkip; readonly durationMs: number };

// A skip is always an ordinary outcome, not an error. A thrown retrieval is swallowed, against this repo's usual
// let-it-propagate rule: failing the user's turn over an optimisation they didn't ask for would be worse than not
// having it.
export const retrieveTurnContext = async (deps: TurnContextDeps, prompt: string): Promise<TurnContextOutcome> => {
    const startedAt = Date.now();
    const durationMs = (): number => Date.now() - startedAt;
    const query = retrievalQueryOf(prompt);
    if (query === undefined) {
        return { skipped: "ineligible", durationMs: durationMs() };
    }
    const controller = new AbortController();
    let failed = false;
    const attempt = deps.iq
        .run(
            {
                verb: "q",
                query,
                scope: {},
                render: { budget: CONTEXT_BUDGET_TOKENS },
                options: {},
                // The CLI form of the same call: seeds the pagination cursor and is what the note tells the model ran.
                echo: `"${query}"`,
            },
            controller.signal,
        )
        .catch((error: unknown) => {
            // The deadline aborts by design; only a genuine failure is worth a log line.
            if (!controller.signal.aborted) {
                failed = true;
                deps.logger.warn({ err: error }, "turn context: retrieval failed, the turn runs without pre-injected context");
            }
            return undefined;
        });
    // Raced rather than left to the abort alone: the signal only reaches the query's cancellable half (the rg child);
    // the model stages run on another thread and ignore it, so a stuck query would hang without this.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
        }, RETRIEVAL_DEADLINE_MS);
    });
    const outcome = await Promise.race([attempt, deadline]);
    clearTimeout(timer);
    // Exit 1 is grep's "no hits" convention; a `building` index only covers part of the workspace. Logged at debug, not
    // warn: none of this is a fault.
    const skip = (skipped: TurnContextSkip): TurnContextOutcome => {
        deps.logger.debug({ skipped, query }, "turn context: nothing prepended");
        return { skipped, durationMs: durationMs() };
    };
    if (outcome === undefined) {
        return skip(failed ? "failed" : "deadline");
    }
    if (outcome.result.freshness.state === "building") {
        return skip("indexing");
    }
    if (outcome.exitCode !== 0 || outcome.result.groups.length === 0) {
        return skip("no-hits");
    }
    return { note: turnContextNote(query, outcome.text), durationMs: durationMs() };
};
