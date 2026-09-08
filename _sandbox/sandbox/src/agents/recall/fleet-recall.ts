import type { GitChange, MatchSnippet, TranscriptRow } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { agentRepoReview } from "../land/agent-changes.js";
import { isIsolated, type PersistedAgent } from "../registry/agents-store.js";

// The join behind `agents ls|show|find`: everything about one conversation in a single answer, from a handle alone.
// Read-only; steering is `agents send`, landing, archiving and discarding are the board's own actions. Returns data,
// not text; the CLI renders it.

export type FleetRecallDeps = Pick<Services, "agents" | "agentWorktrees" | "transcripts" | "saidIndex">;

// Five spellings resolve to a handle, in this order, first hit wins, exact before fuzzy so an id is never shadowed by a
// prefix:
// - id
// - branch (`agent/<id>`)
// - session id
// - unambiguous id prefix
// - unambiguous title substring
export type HandleResolution =
    | { readonly kind: "found"; readonly entry: PersistedAgent }
    // Several matches: named rather than picked silently, so a caller does not read about the wrong agent.
    | { readonly kind: "ambiguous"; readonly candidates: readonly PersistedAgent[] }
    | { readonly kind: "unknown" };

// Cap on ambiguous candidates shown; more than this is a signal to search, not a list to print.
const AMBIGUITY_LIMIT = 6;

const foldOf = (text: string): string => text.toLowerCase();

// Keys with a defined value only; `exactOptionalPropertyTypes` makes an explicit `undefined` differ from an absent key,
// so `Partial` will not do.
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

const present = <T extends object>(fields: T): Present<T> =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Present<T>;

const allEntries = (deps: FleetRecallDeps): PersistedAgent[] =>
    deps.agents.ids().flatMap((id) => {
        const entry = deps.agents.entry(id);
        return entry === undefined ? [] : [entry];
    });

// The three exact spellings (id, `agent/<id>` branch, session id), tried before either fuzzy pass. Session id also
// checks the live registry, since a running conversation's first turn has not flushed its session to the column yet.
const exactly = (deps: FleetRecallDeps, entries: readonly PersistedAgent[], wanted: string): PersistedAgent | undefined =>
    deps.agents.entry(wanted) ??
    (wanted.startsWith("agent/") ? deps.agents.entry(wanted.slice("agent/".length)) : undefined) ??
    entries.find((entry) => entry.branch === wanted) ??
    entries.find((entry) => entry.sessionId === wanted || deps.agents.sessionIdOf(entry.id) === wanted);

// Turns fuzzy candidates into a resolution: one hit is `found`, several are `ambiguous` and named rather than picked.
// Ranked newest first before truncating to `AMBIGUITY_LIMIT`.
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

// One roster row: enough to pick the right conversation without scrolling. Everything heavier (diff, record, failure
// detail) is `agents show`.
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
    // True while a turn is in flight; `status` alone cannot say, it holds `interrupted` throughout a running turn.
    readonly running: boolean;
    readonly repos: readonly string[];
    // Why this row matched a search; absent on a roster read, and when the title itself was the match.
    readonly snippet?: MatchSnippet;
}

const rowOf = (deps: FleetRecallDeps, entry: PersistedAgent, snippet?: MatchSnippet): FleetRow => ({
    id: entry.id,
    // Projected status when available, matching the board, so the CLI and fleet view never disagree.
    status: deps.agents.get(entry.id)?.status ?? entry.status,
    provider: entry.provider,
    updatedAt: entry.updatedAt,
    archived: entry.archivedAt !== undefined,
    running: deps.agents.running(entry.id),
    repos: entry.repos.map((repo) => repo.repo),
    ...present({ title: entry.title, model: entry.model, branch: entry.branch, turns: entry.turns, snippet }),
});

export interface RosterOptions {
    // Include the archive; off by default, matching the board's live-only view.
    readonly all?: boolean;
    readonly limit?: number;
    // Only conversations whose composition includes this repo.
    readonly repo?: string;
}

const ROSTER_LIMIT = 30;

// Entries for a roster or search, newest activity first: live only unless `all`, scoped to `repo` when given.
const scopedEntries = (deps: FleetRecallDeps, options: RosterOptions): PersistedAgent[] =>
    allEntries(deps)
        .filter((entry) => (options.all === true || entry.archivedAt === undefined) && (options.repo === undefined || entry.repos.some((repo) => repo.repo === options.repo)))
        .sort((left, right) => right.updatedAt - left.updatedAt);

export const fleetRoster = (deps: FleetRecallDeps, options: RosterOptions = {}): readonly FleetRow[] =>
    scopedEntries(deps, options)
        .slice(0, options.limit ?? ROSTER_LIMIT)
        .map((entry) => rowOf(deps, entry));

// Searches the fleet's phrase index once rather than per conversation. A title match counts too, with no snippet: the
// title is already on the row.
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

// One repo of a conversation's work. `landed` is the registry's one-way flag, free to read; the counts come from git
// and may be absent (a retired checkout, a pruned branch) without failing the whole answer.
export interface FleetRepo {
    readonly repo: string;
    readonly base: string;
    readonly landed: boolean;
    readonly landedAt?: number;
    readonly files?: number;
    readonly additions?: number;
    readonly deletions?: number;
    // Reason git could not answer, when the counts above are absent.
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

// The digest: opening prompts (the task), the last thing said (where it got to), and the last notice (how it ended),
// each clamped. The full record is one flag away, `--transcript`.
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

// Everything about one conversation, assembled into a single answer.
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
    // Off skips the git spawns; answers from the registry alone, without per-repo file counts.
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
            // Live session id, not the persisted column, which lags for a running first turn.
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

// The transcript itself, for what the digest did not cover: last messages first, each clamped, `grep` narrowing before
// the limit. Excludes tool calls and thinking; the record's own path has those.
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
