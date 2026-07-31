import type { ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";

/* RETRIEVE FOR THE MESSAGE BEFORE THE TURN STARTS — the daemon runs the user's own words through the resident
 * iq engine and prepends the ranked answer to them, so the model opens with `path:line` anchors instead of
 * spending its first two or three tool calls discovering them.
 *
 * WHY BEFORE AND NOT AS A TOOL. A tool the model may call costs a definition in every request and a round trip
 * whenever it fires — the graperoot benchmark this is modelled on measured its own MCP form 15.8% MORE
 * expensive on complex prompts for exactly that reason, while the pre-injection form it also tried came out
 * ~45% cheaper. The retrieval is the same either way; what differs is who pays for the decision to run it. The
 * daemon already holds a warm index (composition.ts) and the query is already typed, so here it is free.
 *
 * WHAT MAKES IT SAFE TO BE WRONG. Injected context is a suggestion, not an instruction: the note says what was
 * searched and that it may have missed, and the agent's own search tools are untouched. The cost of a miss is
 * the tokens it occupied, which is why the gates below are conservative — a prompt that names its own file, or
 * that says nothing to search for, is left alone rather than answered with a guess.
 *
 * It rides the USER message (turn-preamble.ts), never the system prompt: it changes every turn, and the system
 * prefix is kept byte-stable so the provider prompt cache survives the session. */

export const TURN_CONTEXT_NOTE_HEADER = "## Retrieved workspace context";

// The note's share of the turn. The iq renderer treats this as a hard budget and drops whole groups from the
// tail to hold it, so the top hits arrive as real code rather than as a longer list of pointers. ~1.2k is the
// band the graperoot prototype found paid for itself; well under a percent of a 200k window either way.
const CONTEXT_BUDGET_TOKENS = 1200;

// Retrieval reads a long prompt's OPENING, not the whole thing: past a few sentences a prompt is a spec, and
// every term after the ask dilutes the query it is supposed to sharpen (BM25 and the embedder both average).
const QUERY_MAX_CHARS = 400;

// A turn must never visibly wait on this. The resident engine serves from a warm index and typically answers in
// a few hundred ms; past the deadline the turn goes on without the note and the query is abandoned mid-flight.
const RETRIEVAL_DEADLINE_MS = 2_000;

/* Words that carry no search intent. A prompt made of nothing but these is the user talking TO the agent —
 * "go on", "yes please do that", "thanks, looks good" — and retrieving for it returns whatever the index thinks
 * those words mean, which is noise with an `answer:` line on top. Deliberately small: it only has to catch the
 * conversational turns, and every word here is one no query would be worse off without. */
const CONVERSATIONAL = new Set(
    "a about again all also am an and any are as at be been but by can cool could did do does doing done fine for from go going good great has have how i if in is it its just keep let like looks make me more my need next no not now of ok okay on one only or our out over please pls same should so some sounds sure than thanks that the their them then there these they this those thx to too try up us was we well were what when where which who why will with would yeah yes yep you your yours".split(
        " ",
    ),
);

// Fewer words than this and there is not enough query to retrieve on — a two-word follow-up ("the tests",
// "keep going") means whatever the previous turn established, which the model has and the index does not.
const MIN_QUERY_WORDS = 3;

/* A path or filename the user typed. The model can just open it, and it will: retrieval on top of an
 * already-named anchor spends tokens to point at the thing being pointed at. Both spellings count — a
 * slash-bearing path (`_apps/sandbox/src`, `./src/x`, `/work/README.md`) and a bare filename with a source-ish
 * extension (`turn-plan.ts`) — because either one is the user having done the locating already. */
const EXPLICIT_PATH = /(^|\s)[\w.~-]*\/[\w./-]+/;
const EXPLICIT_FILE =
    /(^|\s)[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|rb|php|cs|kt|swift|scala|c|h|cpp|sql|sh|css|scss|html|json|ya?ml|toml|md)\b/i;

/* WHAT THIS TURN IS WORTH RETRIEVING FOR, or undefined when the answer is "nothing".
 *
 * Every gate here is a case where injecting would cost tokens and buy nothing, and each is cheap to state
 * exactly because it is lexical: this runs on the daemon before the turn, so it cannot afford a model call to
 * decide whether a model call needs help.
 *
 * The returned string is what actually goes to the engine — the prompt's opening, trimmed — so the note can
 * echo the query it ran and the reader can see whether it was on target. */
export const retrievalQueryOf = (prompt: string): string | undefined => {
    const text = prompt.trim();
    // A slash command is a command to the CLI, not a question about the workspace.
    if (text === "" || text.startsWith("/")) {
        return undefined;
    }
    if (EXPLICIT_PATH.test(text) || EXPLICIT_FILE.test(text)) {
        return undefined;
    }
    const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) ?? [];
    if (words.length < MIN_QUERY_WORDS || words.every((word) => CONVERSATIONAL.has(word))) {
        return undefined;
    }
    if (text.length <= QUERY_MAX_CHARS) {
        return text;
    }
    // Cut at the last word boundary inside the cap, so the query never ends mid-identifier.
    const head = text.slice(0, QUERY_MAX_CHARS);
    const lastSpace = head.lastIndexOf(" ");
    return lastSpace > 0 ? head.slice(0, lastSpace) : head;
};

export const turnContextNote = (query: string, answer: string): string =>
    `${TURN_CONTEXT_NOTE_HEADER}\n\n` +
    `Not the user's words. Before this turn the daemon searched this workspace for the message below and pasted ` +
    `the ranked answer here, so the first search is already paid for. It ran \`iq "${query}"\`.\n\n` +
    `Treat it as a starting point, not an answer: it may have missed the question entirely, the anchors are ` +
    `positions to read rather than facts, and your own search tools are still the way to check.\n\n` +
    `${answer.trim()}`;

export interface TurnContextDeps {
    readonly iq: Pick<ResidentEngine, "run">;
    readonly logger: Pick<Logger, "warn">;
}

/* The note for this turn, or undefined when there is nothing worth prepending.
 *
 * Undefined is the ordinary outcome and never an error: an ineligible prompt, an index that hasn't caught up
 * with disk yet, a query that matched nothing, a retrieval that outran its deadline. Each of those is a turn
 * that proceeds exactly as it would have without the feature.
 *
 * A THROWN RETRIEVAL IS SWALLOWED, against this repo's usual let-it-propagate rule, and the exception is
 * deliberate: this is an optimisation the user did not ask for on this turn, so a corrupt index or an rg that
 * died must cost the note and nothing else. Killing the user's turn over a failed search would make the feature
 * strictly worse than not having it — the same reasoning the resident engine's onIndexError already runs on. */
export const retrieveTurnContext = async (deps: TurnContextDeps, prompt: string): Promise<string | undefined> => {
    const query = retrievalQueryOf(prompt);
    if (query === undefined) {
        return undefined;
    }
    const controller = new AbortController();
    const attempt = deps.iq
        .run(
            {
                verb: "q",
                query,
                scope: {},
                render: { budget: CONTEXT_BUDGET_TOKENS },
                options: {},
                // The CLI form of the same call, which is what seeds the pagination cursor id — and what the
                // note tells the model was run, so the two never disagree.
                echo: `"${query}"`,
            },
            controller.signal,
        )
        .catch((error: unknown) => {
            // The deadline aborts by design; only a genuine failure is worth a line in the log.
            if (!controller.signal.aborted) {
                deps.logger.warn({ err: error }, "turn context: retrieval failed — the turn runs without pre-injected context");
            }
            return undefined;
        });
    /* Raced rather than left to the abort alone, because the signal only reaches the cancellable half of a
     * query (the rg child). A first query that has to load the embedding model runs seconds past the deadline
     * and would hold the turn there — so the deadline is what returns, and the abandoned query finishes into
     * nothing. The abort still goes out: it releases the half that does listen. */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
        }, RETRIEVAL_DEADLINE_MS);
    });
    const outcome = await Promise.race([attempt, deadline]);
    clearTimeout(timer);
    // Exit 1 is "no hits" (grep convention); a `building` index has not yet caught up with disk, so what it
    // holds is a fraction of the workspace and an answer off it would be confidently partial.
    if (outcome === undefined || outcome.exitCode !== 0 || outcome.result.groups.length === 0 || outcome.result.freshness.state === "building") {
        return undefined;
    }
    return turnContextNote(query, outcome.text);
};
