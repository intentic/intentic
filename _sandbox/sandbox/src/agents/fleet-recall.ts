import type { GitChange, MatchSnippet, TranscriptRow } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { agentRepoReview } from "./agent-changes.js";
import { isIsolated, type PersistedAgent } from "./agents-store.js";

/* FLEET RECALL, the join behind `agents ls|show|find` (bin/agents, agents/fleet.routes.ts): everything one
 * conversation is, in one answer, for an agent that has a handle and nothing else.
 *
 * WHY THIS EXISTS, measured rather than assumed. Of the Claude sessions this workspace has run, one in seven
 * contains a run of shell calls hunting for another conversation — `ls /history`, `find`, a hand-written
 * `node -e` reducer over a three-megabyte agents.json, then a raw Read of a transcript file that is most of a
 * megabyte. Median three calls, and the worst of them thirty-five, before the first useful byte. Every one of
 * those rediscovers a layout the daemon has always known, because nothing ever told the model it existed:
 * the registry, the per-conversation record, the worktree, the phrase index. This module is the answer those
 * runs were assembling by hand, and the three verbs are what makes asking cheaper than searching.
 *
 * IT READS AND NEVER WRITES. Steering another conversation is `agents send`; landing, archiving and discarding
 * are the owner's presses on the board. That line is also why the routes over this module live in their own
 * namespace rather than opening `/agents` to the agent token (auth/grants.ts).
 *
 * SHAPES, NOT SENTENCES: everything here answers data. The CLI writes the capsule, because it is the half that
 * knows what a terminal is, and a caller passing `--json` gets exactly what the route said.
 */

export type FleetRecallDeps = Pick<Services, "agents" | "agentWorktrees" | "transcripts" | "saidIndex">;

/* HOW A HANDLE IS SPELLED, which is the whole ergonomic problem. The conversation in the screenshot that
 * started this had `fair-sage-ey2r` in hand — a worktree directory name — and could not turn it into anything,
 * because every surface that would have answered wanted a different spelling of the same conversation. So all
 * five spellings resolve, in the order below, first hit wins:
 *   · the conversation id itself, which is what the registry, the record and the worktree are all keyed on
 *   · the branch (`agent/fair-sage-ey2r`), which is what a `git branch -a` hands you
 *   · the runtime session id, which is what a provider's own store and `iq sessions` show
 *   · an unambiguous id prefix, which is what a half-remembered slug is
 *   · an unambiguous title substring, which is what a person remembers
 * Prefix and title are LAST on purpose: an exact identity must never lose to a fuzzy one, or a conversation
 * whose id is a prefix of another's becomes unreachable. */
export type HandleResolution =
    | { readonly kind: "found"; readonly entry: PersistedAgent }
    /* Several conversations answer to this spelling. Named rather than picked: choosing one silently is how a
     * caller reads about the wrong agent and never finds out. */
    | { readonly kind: "ambiguous"; readonly candidates: readonly PersistedAgent[] }
    | { readonly kind: "unknown" };

// A handful is enough to choose from and short enough to read; a title word matching forty conversations is a
// signal to search, not a list to print, and the CLI says so.
const AMBIGUITY_LIMIT = 6;

const foldOf = (text: string): string => text.toLowerCase();

/* ONLY THE FIELDS THAT HAVE A VALUE. Two thirds of a registry entry is optional, and written out one ternary
 * per field the capsule builder became a wall of `x !== undefined ? {x} : {}` in which a wrong field name
 * would have read as ordinary. `exactOptionalPropertyTypes` is on, so an explicitly-undefined key is NOT the
 * same as an absent one — hence the return type strips undefined rather than settling for `Partial`. */
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

const present = <T extends object>(fields: T): Present<T> =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Present<T>;

const allEntries = (deps: FleetRecallDeps): PersistedAgent[] =>
    deps.agents.ids().flatMap((id) => {
        const entry = deps.agents.entry(id);
        return entry === undefined ? [] : [entry];
    });

/* THE THREE EXACT SPELLINGS, tried before either fuzzy one so that an identity can never lose to a guess: a
 * conversation whose id is a prefix of another's has to stay reachable by its own name.
 *
 * `agent/<id>` is the branch as git writes it, and the id is the rest of it. The session id is asked of the
 * REGISTRY's live view as well as the persisted column, because a conversation's first turn is flushed with
 * its session only at finish — so the column alone misses exactly the conversation most likely to be looked
 * up, the one running right now. */
const exactly = (deps: FleetRecallDeps, entries: readonly PersistedAgent[], wanted: string): PersistedAgent | undefined =>
    deps.agents.entry(wanted) ??
    (wanted.startsWith("agent/") ? deps.agents.entry(wanted.slice("agent/".length)) : undefined) ??
    entries.find((entry) => entry.branch === wanted) ??
    entries.find((entry) => entry.sessionId === wanted || deps.agents.sessionIdOf(entry.id) === wanted);

/* What a fuzzy pass concluded: one hit is the answer, several are NAMED rather than picked. Choosing silently
 * among them is how a caller reads about the wrong conversation and never finds out. Newest first, so a
 * truncated candidate list keeps the ones most likely to have been meant. */
const narrowed = (candidates: readonly PersistedAgent[]): HandleResolution | undefined => {
    const first = candidates[0];
    if (first === undefined) {
        return undefined;
    }
    if (candidates.length === 1) {
        return { kind: "found", entry: first };
    }
    const ranked = [...candidates].sort((left, right) => right.updatedAt - left.updatedAt);
    return { kind: "ambiguous", candidates: ranked.slice(0, AMBIGUITY_LIMIT) };
};

export const resolveHandle = (deps: FleetRecallDeps, handle: string): HandleResolution => {
    const wanted = handle.trim();
    if (wanted === "") {
        return { kind: "unknown" };
    }
    const entries = allEntries(deps);
    const exact = exactly(deps, entries, wanted);
    if (exact !== undefined) {
        return { kind: "found", entry: exact };
    }
    const needle = foldOf(wanted);
    return (
        narrowed(entries.filter((entry) => entry.id.startsWith(wanted))) ??
        narrowed(entries.filter((entry) => entry.title !== undefined && foldOf(entry.title).includes(needle))) ?? { kind: "unknown" }
    );
};

/* ONE ROW OF THE ROSTER: what a caller needs to decide which conversation it meant, and nothing it would have
 * to scroll past to get there. Everything heavier — the diff, the record, the failure's own sentence — is one
 * `agents show` away and named as such. */
export interface FleetRow {
    readonly id: string;
    readonly title?: string;
    readonly status: string;
    readonly provider: string;
    readonly model?: string;
    readonly branch?: string;
    readonly turns?: number;
    readonly updatedAt: number;
    readonly archived: boolean;
    // True while a turn is in flight on this conversation, which the persisted status cannot say: it carries
    // `interrupted` for the whole of a running turn on purpose (agents-store.ts).
    readonly running: boolean;
    readonly repos: readonly string[];
    // Why this row is in a SEARCH answer, in the conversation's own words. Absent on a roster read, and absent
    // in a search when the title was the match — the row already shows it.
    readonly snippet?: MatchSnippet;
}

const rowOf = (deps: FleetRecallDeps, entry: PersistedAgent, snippet?: MatchSnippet): FleetRow => ({
    id: entry.id,
    // The PROJECTED status where there is one (the same reading the board publishes), so the CLI and the fleet
    // view cannot disagree about the same conversation; the persisted one only for an entry off the roster.
    status: deps.agents.get(entry.id)?.status ?? entry.status,
    provider: entry.provider,
    updatedAt: entry.updatedAt,
    archived: entry.archivedAt !== undefined,
    running: deps.agents.running(entry.id),
    repos: entry.repos.map((repo) => repo.repo),
    ...present({ title: entry.title, model: entry.model, branch: entry.branch, turns: entry.turns, snippet }),
});

export interface RosterOptions {
    // Include the archive. Off by default for the reason the board excludes it: a sandbox with a thousand
    // retired conversations should not answer a "what is running" question with all of them.
    readonly all?: boolean;
    readonly limit?: number;
    // Only conversations whose composition spans this repo, which is how "who else is in the extension" is
    // asked in a monorepo workspace.
    readonly repo?: string;
}

const ROSTER_LIMIT = 30;

// The set a roster or a search answers over, newest activity first: live conversations, the archive only when
// asked, and scoped to one repo of the composition where the caller named one.
const scopedEntries = (deps: FleetRecallDeps, options: RosterOptions): PersistedAgent[] =>
    allEntries(deps)
        .filter((entry) => (options.all === true || entry.archivedAt === undefined) && (options.repo === undefined || entry.repos.some((repo) => repo.repo === options.repo)))
        .sort((left, right) => right.updatedAt - left.updatedAt);

export const fleetRoster = (deps: FleetRecallDeps, options: RosterOptions = {}): readonly FleetRow[] =>
    scopedEntries(deps, options)
        .slice(0, options.limit ?? ROSTER_LIMIT)
        .map((entry) => rowOf(deps, entry));

/* WHICH CONVERSATIONS SAID THIS. One query for the whole fleet against the phrase index the daemon already
 * maintains (sessions/search-index.ts), never a read per conversation: on this workspace that is 1 900-odd
 * records and half a gigabyte of transcript, and the board's own filter learned the same lesson the expensive
 * way before the index existed.
 *
 * A TITLE MATCH COUNTS TOO and carries no snippet, the /agents/search rule: the title is already on the row,
 * and repeating it underneath spends the space that evidence wanted. */
export const fleetSearch = async (deps: FleetRecallDeps, query: string, options: RosterOptions = {}): Promise<readonly FleetRow[]> => {
    const needle = foldOf(query);
    const said = await deps.saidIndex.search(query, "conversation", false);
    const matched = scopedEntries(deps, options).flatMap((entry) => {
        if (entry.title !== undefined && foldOf(entry.title).includes(needle)) {
            return [rowOf(deps, entry)];
        }
        const snippet = said.get(entry.id);
        return snippet === undefined ? [] : [rowOf(deps, entry, snippet)];
    });
    return matched.slice(0, options.limit ?? ROSTER_LIMIT);
};

/* WHAT ONE REPO OF A CONVERSATION'S WORK LOOKS LIKE. `landed` is the registry's own one-way record of a delta
 * that reached the main tree, so "did this ever land" costs nothing; the counts come from git and are allowed
 * to be absent, a retired checkout and a branch that has since been pruned are ordinary states here, not
 * failures worth refusing the whole answer over. */
export interface FleetRepo {
    readonly repo: string;
    readonly base: string;
    readonly landed: boolean;
    readonly landedAt?: number;
    readonly files?: number;
    readonly additions?: number;
    readonly deletions?: number;
    // What git said when it could not answer, so a caller reads a reason rather than a blank.
    readonly unavailable?: string;
}

const statOf = (changes: readonly GitChange[]): Pick<FleetRepo, "files" | "additions" | "deletions"> => ({
    files: changes.length,
    additions: changes.reduce((total, change) => total + (change.additions ?? 0), 0),
    deletions: changes.reduce((total, change) => total + (change.deletions ?? 0), 0),
});

const repoStates = async (deps: FleetRecallDeps, entry: PersistedAgent, diff: boolean): Promise<readonly FleetRepo[]> =>
    Promise.all(
        entry.repos.map(async (composed): Promise<FleetRepo> => {
            const landed = {
                repo: composed.repo,
                base: composed.base,
                landed: composed.landedAt !== undefined,
                ...present({ landedAt: composed.landedAt }),
            };
            if (!diff || !isIsolated(entry)) {
                return landed;
            }
            try {
                return { ...landed, ...statOf(await agentRepoReview(deps.agentWorktrees, entry, composed)) };
            } catch (error) {
                return { ...landed, unavailable: error instanceof Error ? error.message : String(error) };
            }
        }),
    );

/* THE DIGEST, and the reason `agents show` is an answer rather than a pointer at 780 KB of JSONL.
 *
 * What a caller asking about another conversation actually wants is the shape of it: what it was asked, where
 * it got to, and how it ended. So: the opening prompts, which is the task; the last thing the agent said, which
 * is where it got to; and the last notice, which is how it stopped when it stopped badly. Whitespace collapsed
 * and each one clamped, because these ride in a capsule and an unclamped prompt is a screenful.
 *
 * The whole record is one flag away (`--transcript`), and the digest names it. That ordering is the budget: the
 * cheap answer first, the expensive one asked for by someone who read the cheap one and still wants more. */
const DIGEST_CHARS = 240;
const DIGEST_PROMPTS = 3;

const collapse = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface FleetDigest {
    readonly messages: number;
    readonly asked: readonly string[];
    readonly lastSaid?: string;
    readonly lastNotice?: string;
}

const digestOf = (messages: readonly TranscriptRow[]): FleetDigest => {
    const spoken = (role: TranscriptRow["role"]): string[] =>
        messages.filter((row) => row.role === role).flatMap((row) => (collapse(row.text) === "" ? [] : [clamp(collapse(row.text), DIGEST_CHARS)]));
    return {
        messages: messages.length,
        asked: spoken("user").slice(0, DIGEST_PROMPTS),
        ...present({ lastSaid: spoken("assistant").at(-1), lastNotice: spoken("notice").at(-1) }),
    };
};

// One conversation, whole. Everything the hunt in the header was assembling by hand.
export interface FleetRecall extends FleetRow {
    readonly harness: string;
    readonly effort?: string;
    readonly account?: string;
    readonly sessionId?: string;
    readonly runner?: string;
    readonly worktree?: string;
    readonly record: string;
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolUses?: number;
    readonly subagents?: number;
    readonly createdAt: number;
    readonly archivedAt?: number;
    readonly failure?: string;
    readonly failureCode?: string;
    readonly limitResetsAt?: number;
    readonly landedSubject?: string;
    readonly repoStates: readonly FleetRepo[];
    readonly digest: FleetDigest;
}

export interface RecallOptions {
    // Off skips the git spawns and answers from the registry alone: everything but the per-repo file counts.
    readonly diff?: boolean;
}

export const recordPathOf = (historyRoot: string, id: string): string => `${historyRoot}/transcripts/${id}.jsonl`;

export const fleetRecall = async (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
    historyRoot: string,
    options: RecallOptions = {},
): Promise<FleetRecall> => {
    const [repos, messages] = await Promise.all([
        repoStates(deps, entry, options.diff !== false),
        deps.transcripts.read(entry).catch((): TranscriptRow[] => []),
    ]);
    return {
        ...rowOf(deps, entry),
        harness: entry.harness,
        record: recordPathOf(historyRoot, entry.id),
        costUsd: entry.costUsd,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        createdAt: entry.createdAt,
        ...present({
            effort: entry.effort,
            account: entry.account,
            // The live view, not the persisted column, for the running first turn the column has not been
            // flushed with yet — which is the conversation most likely to be looked up.
            sessionId: deps.agents.sessionIdOf(entry.id),
            runner: entry.runner,
            worktree: entry.branch === undefined ? undefined : deps.agentWorktrees.conversationDir(entry.id),
            toolUses: entry.toolUses,
            subagents: entry.subagents,
            archivedAt: entry.archivedAt,
            failure: entry.failure,
            failureCode: entry.failureCode,
            limitResetsAt: entry.limitResetsAt,
            landedSubject: entry.landedSubject,
        }),
        repoStates: repos,
        digest: digestOf(messages),
    };
};

/* THE RECORD ITSELF, for the caller the digest did not satisfy. Bounded three ways and by default: the LAST
 * turns rather than the first (a conversation is looked up for where it got to far more often than for how it
 * opened), each row clamped, and `grep` narrowing to the rows that carry a phrase before any of that.
 *
 * Tool calls and thinking stay out. They are the bulk of a transcript and almost never the reason one
 * conversation reads another's: what is wanted is the exchange. A caller who genuinely needs the tool traffic
 * has the record's path in the same answer. */
export interface FleetMessage {
    readonly role: TranscriptRow["role"];
    readonly text: string;
    readonly sentAt?: number;
    readonly at: number;
}

const MESSAGE_CHARS = 1200;
const MESSAGE_LIMIT = 20;

export interface TranscriptOptions {
    readonly last?: number;
    readonly grep?: string;
}

export const fleetMessages = async (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
    options: TranscriptOptions = {},
): Promise<{ readonly total: number; readonly messages: readonly FleetMessage[] }> => {
    const rows = await deps.transcripts.read(entry).catch((): TranscriptRow[] => []);
    const spoken = rows.flatMap((row, at): FleetMessage[] => {
        const text = collapse(row.text);
        return text === "" ? [] : [{ role: row.role, text: clamp(text, MESSAGE_CHARS), at, ...present({ sentAt: row.sentAt }) }];
    });
    const needle = options.grep === undefined ? undefined : foldOf(options.grep);
    const matched = needle === undefined ? spoken : spoken.filter((message) => foldOf(message.text).includes(needle));
    const last = Math.max(1, options.last ?? MESSAGE_LIMIT);
    return { total: matched.length, messages: matched.slice(-last) };
};
