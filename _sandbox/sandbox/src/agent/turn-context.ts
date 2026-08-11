import type { ResidentEngine } from "@intentic/iq-engine";
import type { IqContextOutcome } from "@intentic/sandbox-contract";
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

/* A turn must never visibly wait on this. The resident engine serves from a warm index and typically answers in
 * a few hundred ms; past the deadline the turn goes on without the note and the query is abandoned mid-flight.
 *
 * A BACKSTOP, NOT A BUDGET, which is the difference between this number and the one it replaced. At two seconds
 * it was the thing deciding whether the feature ran at all — the ledger recorded it taking 104 of the 133 turns
 * retrieval was eligible for. The pipeline below is what fixed that; this is only here for the query that goes
 * genuinely wrong. It can afford the extra second because it does not run alone: the planning round it is
 * awaited underneath (extensions, browser bring-up, delegation) averages ~1.5s in production, so the wait a
 * turn actually pays is whatever retrieval takes BEYOND that, and for a p90 near 0.9s that is nothing. */
const RETRIEVAL_DEADLINE_MS = 3_000;

/* WITH THE CROSS-ENCODER — the full pipeline, no stage held back, and worth recording why it took a threading
 * change to get here.
 *
 * This ran WITHOUT the reranker for as long as the reranker ran on the daemon's own thread. It is a transformer
 * in-process, and this query shared that thread with several agent streams, the index worker and the routes:
 * measured against the real prompts of one week, the full pipeline answered in ~1.2s on an idle box and ~2.7s
 * on a busy one, missing the deadline 71% of the time. The ledger says it took 104 of the 133 turns retrieval
 * was eligible for — four notes in five computed and thrown away — so ordering was traded for arrival.
 *
 * Neither stage runs here now. The resident engine answers the semantic scan and the cross-encoder on its query
 * worker (iq-engine's query/query-worker.ts), so this query no longer queues behind whatever else the daemon is
 * doing, and the daemon no longer stalls behind it. Measured against this workspace's index with the daemon's
 * thread held at roughly half duty: the full reranked pipeline answers at p50 ~0.7s, max ~1.2s — well inside
 * the deadline — while the host thread's own work runs 4ms late instead of 400ms late.
 *
 * So the trade the old note described is simply off the table: the candidates were always the same, and which
 * of them leads is now free. */

/* Words that carry no search intent. A prompt made of nothing but these is the user talking TO the agent —
 * "go on", "yes please do that", "thanks, looks good" — and retrieving for it returns whatever the index thinks
 * those words mean, which is noise with an `answer:` line on top. Deliberately small: it only has to catch the
 * conversational turns, and every word here is one no query would be worse off without. */
const CONVERSATIONAL = new Set(
    "a about again all also am an and any are as at be been but by can cool could did do does doing done fine for from go going good great has have how i if in is it its just keep let like looks make me more my need next no not now of ok okay on one only or our out over please pls same should so some sounds sure than thanks that the their them then there these they this those thx to too try up us was we well were what when where which who why will with would yeah yes yep you your yours".split(
        " ",
    ),
);

/* At least one CONTENT word, or there is nothing here to search for. That was already the rule — skip when
 * every word is conversational — and what it was missing is that a bare NUMBER is not content either. One digit
 * defeated the whole gate: "Go for these 2." retrieved, and so did "Go for 1.", each spending its 1.2k budget
 * searching the index for words whose referent is in the previous turn.
 *
 * Deliberately not raised past one. An interrogative frame is made almost entirely of conversational words —
 * "how do we rotate credentials?" has exactly two content words in it — and a threshold high enough to catch
 * follow-ups takes the real questions with it. */
const MIN_CONTENT_WORDS = 1;

/* A prompt that OPENS by pointing backwards is continuing the previous turn, so it has to carry more than a
 * word or two of its own before it is worth a search: "Go for the levers.", "Got for all of it." each cleared
 * the rule above on a single noun that means nothing without the turn before it.
 *
 * A few words is all this can ask for. A resumptive opener followed by real substance ("Also, how does the
 * scheduler decide which automation wakes a sandbox first?") is a genuine question and must still retrieve —
 * which also means the reverse gets through: "Above ideas are bad. Nothing really important. Rethink it."
 * carries six content words, is pure anaphora, and nothing lexical separates the two. That one is left. */
const RESUMPTIVE_OPENER =
    /^\s*(?:go (?:for|ahead|on)|got for|continue|carry on|keep going|proceed|do (?:it|that|both|this)|apply|fix (?:it|that|them|these|those)|try again|redo|instead|also|same|and |but |that |those |these |it )/i;
const MIN_RESUMPTIVE_CONTENT_WORDS = 3;

// A bare number carries no search intent of its own — it enumerates something the previous turn listed.
const isContentWord = (word: string): boolean => !CONVERSATIONAL.has(word) && !/^\d+$/.test(word);

/* A path or filename the user typed. The model can just open it, and it will: retrieval on top of an
 * already-named anchor spends tokens to point at the thing being pointed at. Both spellings count — a
 * slash-bearing path (`_sandbox/sandbox/src`, `./src/x`, `/work/README.md`) and a bare filename with a source-ish
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
    readonly logger: Pick<Logger, "warn" | "debug">;
}

/* WHY NOTHING WAS PREPENDED, when nothing was.
 *
 * Every one of these is an ordinary outcome rather than an error, and until now each was also SILENT: only a
 * thrown retrieval reached the log, which over a day of use meant one line — while the mechanism declined to
 * fire on four turns in five. That gap is what made the experiment unreadable from the outside, because a
 * treatment turn that injected nothing is indistinguishable in the ledger from one that injected 1.2k tokens.
 *
 * `ineligible` is the prompt failing a gate above; the rest are retrieval itself declining. */
export type TurnContextSkip = Exclude<IqContextOutcome, "note">;

// The note, or the reason there isn't one. A union rather than an optional pair: exactly one of the two is
// always the answer, and the ledger's delivery rate is only honest if a caller cannot read both as absent.
export type TurnContextOutcome =
    { readonly note: string; readonly durationMs: number } | { readonly skipped: TurnContextSkip; readonly durationMs: number };

/* The note for this turn, or the reason there is none.
 *
 * A skip is the ordinary outcome and never an error: an ineligible prompt, an index that hasn't caught up with
 * disk yet, a query that matched nothing, a retrieval that outran its deadline. Each of those is a turn that
 * proceeds exactly as it would have without the feature — and each is now NAMED, because "the mechanism was
 * assigned to this turn" and "the mechanism did something on this turn" turned out to be different facts in
 * four turns out of five, and nothing downstream could tell them apart.
 *
 * A THROWN RETRIEVAL IS SWALLOWED, against this repo's usual let-it-propagate rule, and the exception is
 * deliberate: this is an optimisation the user did not ask for on this turn, so a corrupt index or an rg that
 * died must cost the note and nothing else. Killing the user's turn over a failed search would make the feature
 * strictly worse than not having it — the same reasoning the resident engine's onIndexError already runs on. */
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
                // The CLI form of the same call, which is what seeds the pagination cursor id — and what the
                // note tells the model was run, so the two never disagree.
                echo: `"${query}"`,
            },
            controller.signal,
        )
        .catch((error: unknown) => {
            // The deadline aborts by design; only a genuine failure is worth a line in the log.
            if (!controller.signal.aborted) {
                failed = true;
                deps.logger.warn({ err: error }, "turn context: retrieval failed — the turn runs without pre-injected context");
            }
            return undefined;
        });
    /* Raced rather than left to the abort alone, because the signal only reaches the cancellable half of a
     * query (the rg child). The model stages answer from another thread and take no signal at all, so a query
     * that goes long — a cold worker, an index mid-rebuild — would hold the turn there. The deadline is what
     * returns, and the abandoned query finishes into nothing. The abort still goes out: it releases the half
     * that does listen. */
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
    // Debug, not warn: none of these is a fault, and the reason is only wanted in aggregate — "how often did the
    // treatment arm actually get treated, and what took the rest of it away".
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
