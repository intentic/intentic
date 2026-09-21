import type { QueryRequest, ResidentEngine } from "@intentic/iq-engine";
import type { Logger } from "pino";

// Runs the user's prompt through the resident iq engine before the turn starts and prepends the ranked answer, so the
// model opens with path:line anchors instead of spending tool calls finding them. Rides the user message, not a
// callable tool or the system prompt: cheaper than a round trip and keeps the cached system prefix byte-stable.

export const TURN_CONTEXT_NOTE_TITLE = "Workspace context found for this message";
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

const SOURCE_EXTENSIONS =
    "ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|rb|php|cs|kt|swift|scala|c|h|cpp|sql|sh|css|scss|html|json|ya?ml|toml|md";

// Either a slash-bearing path or a bare filename with a source-ish extension. A trailing `:12` is kept: a line the user
// quoted is the tightest anchor the message has.
const EXPLICIT_PATH = new RegExp(String.raw`(?:^|[\s('"\`])([\w.~-]*\/[\w./-]+?\.(?:${SOURCE_EXTENSIONS}))(?::(\d+))?\b`, "gi");
const EXPLICIT_FILE = new RegExp(String.raw`(?:^|[\s('"\`])([\w.-]+\.(?:${SOURCE_EXTENSIONS}))(?::(\d+))?\b`, "gi");
// Python and V8 frames: both carry the file a failure actually came through.
const TRACEBACK_FRAME = /File "([^"]+)", line (\d+)|at [^(]*\(([^:)]+):(\d+):\d+\)/g;

// Text the user quoted verbatim, in backticks or quotes. Grepped exactly rather than searched semantically: a pasted
// error string either appears in the code or it does not, and the fused pipeline dilutes it against the prose around it.
const QUOTED = /`([^`\n]{4,120})`|"([^"\n]{4,120})"|'([^'\n]{4,120})'/g;

// Ceilings per evidence class, so one pathological prompt cannot fan out into a dozen engine calls.
const MAX_PATHS = 3;
const MAX_LITERALS = 2;

// Punctuation that hardly occurs in prose but is everywhere in code, or an interior capital (camelCase).
const CODEISH = /[_/.()[\]{}=<>:;$#@|\\]|[a-z][A-Z]/;

// A literal worth grepping is code, or long enough to be a real message someone pasted. A quoted English word is a
// phrase — grepping it burns a call and returns noise, which is why the length floor alone is not the test.
const isGreppable = (literal: string): boolean => /[A-Za-z0-9_]/.test(literal) && (CODEISH.test(literal) || literal.length >= 20);

// A bare filename that some fuller path already covers, and an uncheckpointed path that a `path:line` already covers, are
// the same evidence twice: the regexes overlap by design, so the narrower form wins.
const isCoveredBy = (path: string, others: readonly string[]): boolean =>
    others.some((other) => other !== path && (other.endsWith(`/${path}`) || new RegExp(`^${path.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}:\\d+$`).test(other)));

// What the daemon looks up, in weight order: a file the user named beats text they quoted, which beats the prompt read
// as a question. Paths are the strongest class precisely BECAUSE the user already located the code — the gate this
// replaced skipped retrieval there, which spent that certainty instead of using it.
export interface RetrievalEvidence {
    // As written, with `:line` kept when one was given.
    readonly paths: readonly string[];
    readonly literals: readonly string[];
    // The prompt's opening; absent when a path already localized the turn, or when the prompt carries no search intent.
    readonly query: string | undefined;
}

const framesIn = (text: string): string[] =>
    [...text.matchAll(TRACEBACK_FRAME)].map((match) =>
        match[1] === undefined ? `${match[3] ?? ""}:${match[4] ?? ""}` : `${match[1]}:${match[2] ?? ""}`,
    );

const namedIn = (text: string, pattern: RegExp): string[] =>
    [...text.matchAll(pattern)].map((match) => (match[2] === undefined ? (match[1] ?? "") : `${match[1] ?? ""}:${match[2]}`));

const pathsIn = (text: string): string[] => {
    const found = [
        ...new Set(
            [...framesIn(text), ...namedIn(text, EXPLICIT_PATH), ...namedIn(text, EXPLICIT_FILE)]
                // An absolute or escaping path is not this workspace's to open, and the engine would reject it anyway.
                .filter((path) => path !== "" && !path.startsWith("/") && !path.startsWith("..")),
        ),
    ];
    return found.filter((path) => !isCoveredBy(path, found)).slice(0, MAX_PATHS);
};

const literalsIn = (text: string): string[] => {
    const found = [...text.matchAll(QUOTED)]
        .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
        .filter((literal) => literal.length >= 4 && isGreppable(literal));
    return [...new Set(found)].slice(0, MAX_LITERALS);
};

// The prompt's opening, trimmed, so the note can echo the query it ran.
const queryIn = (text: string): string | undefined => {
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

// Every gate here is lexical: this runs before the turn, with no model call available to judge whether one needs help.
export const retrievalEvidenceOf = (prompt: string): RetrievalEvidence | undefined => {
    const text = prompt.trim();
    // A slash command is a command to the CLI, not a question about the workspace.
    if (text === "" || text.startsWith("/")) {
        return undefined;
    }
    const paths = pathsIn(text);
    // A path quoted in backticks is already the stronger class; grepping its own name on top adds a call and no facts.
    const literals = literalsIn(text).filter((literal) => !paths.some((path) => path === literal || path.startsWith(`${literal}:`)));
    // A named path localizes the turn on its own, and the fused query is much the most expensive call: dropping it
    // there keeps the common "fix foo.ts" message to one cheap lookup.
    const query = paths.length > 0 ? undefined : queryIn(text);
    if (paths.length === 0 && literals.length === 0 && query === undefined) {
        return undefined;
    }
    return { paths, literals, query };
};

const turnContextNote = (ran: readonly string[], sections: readonly string[], converged: readonly string[]): string =>
    `${TURN_CONTEXT_NOTE_HEADER}\n\n` +
    `Not the user's words. Before this turn the daemon looked this workspace up for the message below and pasted the ` +
    `ranked answers here, so the first searches are already paid for. It ran ${ran.map((command) => `\`${command}\``).join(", ")}.\n\n${ 
    converged.length > 0
        ? `More than one of those landed on ${converged.map((path) => `\`${path}\``).join(", ")} — start there.\n\n`
        : "" 
    }Treat it as a starting point, not an answer: it may have missed the question entirely, the anchors are ` +
    `positions to read rather than facts, and your own search tools are still the way to check.\n\n${sections.join("\n\n").trim()}`;

export interface TurnContextDeps {
    readonly iq: Pick<ResidentEngine, "run">;
    readonly logger: Pick<Logger, "warn" | "debug">;
}

// Named rather than silent, so a turn where nothing fired is distinguishable from one that succeeded. `ineligible`
// fails a gate above; the rest are retrieval itself declining.
export type TurnContextSkip = "ineligible" | "deadline" | "indexing" | "no-hits" | "failed";

// Which evidence classes produced the note, strongest first. Recorded so the local measurement can ask whether the
// cheap classes carry the feature and the expensive fused query earns its latency.
export type TurnContextStrategy = "paths" | "literals" | "query";

// A union, not an optional pair: exactly one side is always present, so a caller can't read both note and skip as
// absent.
export type TurnContextOutcome =
    | { readonly note: string; readonly durationMs: number; readonly strategies: readonly TurnContextStrategy[]; readonly paths: readonly string[] }
    | { readonly skipped: TurnContextSkip; readonly durationMs: number };

// One evidence class's lookup, already shaped as an engine request.
interface Lookup {
    readonly strategy: TurnContextStrategy;
    readonly request: QueryRequest;
    // How the note introduces this section, and what the header says ran.
    readonly ran: string;
    readonly label: string;
}

// Budget per class. The classes are additive, so each gets a slice rather than the whole note: a prompt that names a
// file AND quotes an error should show both, not whichever ran first.
const budgetFor = (classes: number): number => Math.floor(CONTEXT_BUDGET_TOKENS / Math.max(classes, 1));

const lookupsFor = (evidence: RetrievalEvidence): Lookup[] => {
    const classes = (evidence.paths.length > 0 ? 1 : 0) + (evidence.literals.length > 0 ? 1 : 0) + (evidence.query === undefined ? 0 : 1);
    const budget = budgetFor(classes);
    const base = { scope: {}, options: {}, render: { budget } } as const;
    const lookups: Lookup[] = [];
    for (const path of evidence.paths) {
        // A `path:line` the user quoted has an enclosing scope worth showing; a bare path has a shape worth showing.
        const anchored = /:\d+$/.test(path);
        lookups.push({
            strategy: "paths",
            request: { ...base, verb: anchored ? "context" : "outline", query: path, echo: path },
            ran: `iq ${anchored ? "context" : "outline"} ${path}`,
            label: `### \`${path}\` — the file this message named`,
        });
    }
    for (const literal of evidence.literals) {
        lookups.push({
            strategy: "literals",
            request: { ...base, verb: "find", query: literal, options: { literal: true }, echo: `find ${JSON.stringify(literal)} --literal` },
            ran: `iq find ${JSON.stringify(literal)} --literal`,
            label: `### \`${literal}\` — quoted in this message, matched exactly`,
        });
    }
    if (evidence.query !== undefined) {
        lookups.push({
            strategy: "query",
            request: { ...base, verb: "q", query: evidence.query, echo: `"${evidence.query}"` },
            ran: `iq "${evidence.query}"`,
            label: "### the message, read as a question",
        });
    }
    return lookups;
};

// A skip is always an ordinary outcome, not an error. A thrown retrieval is swallowed, against this repo's usual
// let-it-propagate rule: failing the user's turn over an optimisation they didn't ask for would be worse than not
// having it.
export const retrieveTurnContext = async (deps: TurnContextDeps, prompt: string): Promise<TurnContextOutcome> => {
    const startedAt = Date.now();
    const durationMs = (): number => Date.now() - startedAt;
    const evidence = retrievalEvidenceOf(prompt);
    if (evidence === undefined) {
        return { skipped: "ineligible", durationMs: durationMs() };
    }
    const controller = new AbortController();
    // Cheap classes first, and ONE deadline over all of them: outline and a literal grep are SQLite and rg, while the
    // fused query runs the semantic scan and the cross-encoder. Ordering this way means a slow `q` costs itself and not
    // the lookups that would have answered anyway.
    const attempt = (async () => {
        const done: Array<{ lookup: Lookup; text: string; paths: string[] }> = [];
        let building = false;
        let threw: unknown;
        let ran = 0;
        for (const lookup of lookupsFor(evidence)) {
            if (controller.signal.aborted) {
                break;
            }
            ran += 1;
            const outcome = await deps.iq.run(lookup.request, controller.signal).catch((error: unknown) => {
                // One class declining (a path the engine rejects, a pattern it will not take) must not cost the others
                // their answers; only every class throwing means retrieval itself is broken.
                threw ??= error;
                deps.logger.debug({ err: error, strategy: lookup.strategy }, "turn context: one lookup declined");
                return undefined;
            });
            if (outcome === undefined) {
                continue;
            }
            building ||= outcome.result.freshness.state === "building";
            if (outcome.exitCode === 0 && outcome.result.groups.length > 0) {
                done.push({ lookup, text: outcome.text, paths: outcome.result.groups.map((group) => group.path) });
            }
        }
        return { done, building, brokeThroughout: threw !== undefined && done.length === 0 && ran > 0, error: threw };
    })();
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
    controller.abort();
    // Exit 1 is grep's "no hits" convention; a `building` index only covers part of the workspace. Logged at debug, not
    // warn: none of this is a fault.
    const skip = (skipped: TurnContextSkip): TurnContextOutcome => {
        deps.logger.debug({ skipped, evidence }, "turn context: nothing prepended");
        return { skipped, durationMs: durationMs() };
    };
    if (outcome === undefined) {
        return skip("deadline");
    }
    if (outcome.brokeThroughout) {
        deps.logger.warn({ err: outcome.error }, "turn context: retrieval failed, the turn runs without pre-injected context");
        return skip("failed");
    }
    // Checked before hits: a building index holds a fraction of the workspace, so its answer would be confidently
    // partial whether or not it found something.
    if (outcome.building) {
        return skip("indexing");
    }
    if (outcome.done.length === 0) {
        return skip("no-hits");
    }
    // Convergence: a path two classes both reached is the strongest thing this note knows, and the one line worth
    // spending on a lead. Benzi ranks its whole symptom map this way.
    const seen = new Map<string, number>();
    for (const { paths } of outcome.done) {
        for (const path of new Set(paths)) {
            seen.set(path, (seen.get(path) ?? 0) + 1);
        }
    }
    const converged = [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path);
    return {
        note: turnContextNote(
            outcome.done.map(({ lookup }) => lookup.ran),
            outcome.done.map(({ lookup, text }) => `${lookup.label}\n\n${text.trim()}`),
            converged,
        ),
        durationMs: durationMs(),
        strategies: [...new Set(outcome.done.map(({ lookup }) => lookup.strategy))],
        paths: [...seen.keys()],
    };
};
