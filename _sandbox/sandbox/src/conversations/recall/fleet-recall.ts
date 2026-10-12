import { errorMessage } from "@intentic/base/errors";
import type { GitChange, SessionOwner, TranscriptRow, TurnReach } from "@intentic/sandbox-contract";
import { readableProviderText } from "../../agent/providers/provider-error-text.js";
import type { Services } from "../../composition.js";
import { agentRepoChanges } from "../land/agent-changes.js";
import type { FoundLine } from "../../sessions/search-index.js";
import { transcriptFile } from "../../sessions/transcript-record.js";
import { type FleetNow, fleetNow } from "./fleet-now.js";
import { type Ending, endingStatus, isIsolated, type PersistedAgent, reposOf } from "../registry/agents-store.js";

// The join behind `agents ls|show|find`: everything about one conversation in a single answer, from a handle alone.
// Read-only; steering is `agents send`, landing, archiving and discarding are the board's own actions. Returns data,
// not text; the CLI renders it.

export type FleetRecallDeps = Pick<Services, "agents" | "conversations" | "agentWorktrees" | "transcripts" | "saidIndex">;

// These spellings resolve to a handle, in this order, first hit wins, exact before fuzzy so an id is never shadowed by a
// prefix:
// - id
// - branch (`agent/<id>`)
// - session id
// - unambiguous session id prefix (eight hex digits or more), or a terminal named for one (`agent-<8 hex>-%N.log`)
// - unambiguous id prefix
// - unambiguous title substring
// fleet-handles.ts adds what only a record the registry does not hold can answer: retired sessions, runs, turns and
// in-process subagents.
export type HandleResolution =
    // `via` says how a handle that is none of the conversation's own names led to it.
    | { readonly kind: "found"; readonly entry: PersistedAgent; readonly via?: string }
    // Several matches: named rather than picked silently, so a caller does not read about the wrong agent.
    | { readonly kind: "ambiguous"; readonly candidates: readonly PersistedAgent[] }
    | { readonly kind: "unknown" };

// Cap on ambiguous candidates shown; more than this is a signal to search, not a list to print.
const AMBIGUITY_LIMIT = 6;

const foldOf = (text: string): string => text.toLowerCase();

// Keys with a defined value only; `exactOptionalPropertyTypes` makes an explicit `undefined` differ from an absent key,
// so `Partial` will not do.
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export const present = <T extends object>(fields: T): Present<T> =>
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
    entries.find((entry) => entry.placement.kind === "worktree" && entry.placement.branch === wanted) ??
    entries.find((entry) => entry.sessionId === wanted || deps.conversations.sessionIdOf(entry.id) === wanted);

// Whether its name holds the folded needle.
const titled = (entry: PersistedAgent, needle: string): boolean => entry.social.title !== undefined && foldOf(entry.social.title.text).includes(needle);

// One of several conversations a handle matched, as the refusal names it.
export const candidateOf = (entry: PersistedAgent): { id: string; title?: string; status: string; updatedAt: number } => ({
    id: entry.id,
    ...present({ title: entry.social.title?.text }),
    status: endingStatus(entry.ending),
    updatedAt: entry.updatedAt,
});

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

// The session prefix a handle spells, if it spells one: eight hex digits or more, as logs and the history list shorten a
// session id, or a terminal's name, which the runtime takes from the first eight (terminals/agent-126a7bc4-%551.log).
const SESSION_PREFIX = /^[0-9a-f]{8}(?:-[0-9a-f-]*)?$/u;
const TERMINAL = /^agent-([0-9a-f]{8})(?:-%\d+(?:\.log)?)?$/u;
const sessionPrefixOf = (handle: string): string | undefined => TERMINAL.exec(handle)?.[1] ?? (SESSION_PREFIX.test(handle) ? handle : undefined);

const inSession = (deps: FleetRecallDeps, entry: PersistedAgent, prefix: string): boolean =>
    entry.sessionId?.startsWith(prefix) === true || deps.conversations.sessionIdOf(entry.id)?.startsWith(prefix) === true;

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
    const prefix = sessionPrefixOf(wanted);
    const needle = foldOf(wanted);
    return (
        (prefix === undefined ? undefined : narrowed(entries.filter((entry) => inSession(deps, entry, prefix)))) ??
        narrowed(entries.filter((entry) => entry.id.startsWith(wanted))) ??
        narrowed(entries.filter((entry) => titled(entry, needle))) ?? { kind: "unknown" }
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
    // Who answers for it, and who asked for its first turn (an email, `token:<label>`, `agent:<parent id>`); either
    // may be absent, both for a wake nobody has claimed.
    readonly owner?: SessionOwner;
    readonly startedBy?: string;
    // Why this row matched a search; absent on a roster read, and when the title itself was the match. `via` marks a
    // line it did rather than said: a tool call, a question card, a notice, a run.
    readonly snippet?: FoundLine;
}

const rowOf = (deps: FleetRecallDeps, entry: PersistedAgent, snippet?: FoundLine): FleetRow => ({
    id: entry.id,
    // Projected status when available, matching the board, so the CLI and fleet view never disagree.
    status: deps.agents.get(entry.id)?.status ?? endingStatus(entry.ending),
    provider: entry.profile.provider,
    updatedAt: entry.updatedAt,
    archived: entry.archivedAt !== undefined,
    running: deps.conversations.running(entry.id),
    repos: reposOf(entry).map((repo) => repo.repo),
    turns: entry.totals.turns,
    ...present({
        title: entry.social.title?.text,
        model: entry.profile.model,
        branch: entry.placement.kind === "worktree" ? entry.placement.branch : undefined,
        owner: entry.social.owner,
        startedBy: entry.identity.startedBy,
        snippet,
    }),
});

export interface RosterOptions {
    // Include the archive; off by default, matching the board's live-only view.
    readonly all?: boolean;
    readonly limit?: number;
    // Only conversations whose composition includes this repo.
    readonly repo?: string;
    // Only conversations a member answers for, by any part of their address (`ania` finds ania@example.com).
    readonly owner?: string;
}

const ROSTER_LIMIT = 30;

const ownedBy = (entry: PersistedAgent, owner: string | undefined): boolean =>
    owner === undefined || (entry.social.owner !== undefined && foldOf(entry.social.owner.email).includes(foldOf(owner)));

// Entries for a roster or search, newest activity first: live only unless `all`, scoped to `repo` and `owner` when
// given.
const scopedEntries = (deps: FleetRecallDeps, options: RosterOptions): PersistedAgent[] =>
    allEntries(deps)
        .filter(
            (entry) =>
                (options.all === true || entry.archivedAt === undefined) &&
                (options.repo === undefined || reposOf(entry).some((repo) => repo.repo === options.repo)) &&
                ownedBy(entry, options.owner),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);

export const fleetRoster = (deps: FleetRecallDeps, options: RosterOptions = {}): readonly FleetRow[] =>
    scopedEntries(deps, options)
        .slice(0, options.limit ?? ROSTER_LIMIT)
        .map((entry) => rowOf(deps, entry));

// Searches the fleet's phrase index once rather than per conversation, deeds included: what an agent hunts for is as
// often a command or a path it ran as a sentence. A title match counts too, with no snippet: the title is already on
// the row.
export const fleetSearch = async (deps: FleetRecallDeps, query: string, options: RosterOptions = {}): Promise<readonly FleetRow[]> => {
    const needle = foldOf(query);
    const said = await deps.saidIndex.search(query, "conversation", false, true);
    const matched = scopedEntries(deps, options).flatMap((entry) => {
        if (titled(entry, needle)) {
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
        reposOf(entry).map(async (composed): Promise<FleetRepo> => {
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
                // Git's own totals: a recall shows sums, which never needed the review's per-row code counts.
                return { ...landed, ...statOf(await agentRepoChanges(deps.agentWorktrees, entry, composed, "cumulative")) };
            } catch (error) {
                return { ...landed, unavailable: errorMessage(error) };
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
    // When the turn the last notice came in was sent (a notice has no clock of its own), and how many messages were
    // recorded after it: a refusal from five turns ago read as the conversation's present state otherwise.
    readonly lastNoticeSentAt?: number;
    readonly sinceLastNotice?: number;
}

const noticeAge = (messages: readonly TranscriptRow[]): Pick<FleetDigest, "lastNoticeSentAt" | "sinceLastNotice"> => {
    const at = messages.findLastIndex((row) => row.role === "notice" && collapse(row.text) !== "");
    if (at === -1) {
        return {};
    }
    const sentAt = messages.slice(0, at).findLast((row) => row.sentAt !== undefined)?.sentAt;
    return present({ lastNoticeSentAt: sentAt, sinceLastNotice: messages.length - at - 1 });
};

const digestOf = (messages: readonly TranscriptRow[]): FleetDigest => {
    const spoken = (role: TranscriptRow["role"]): string[] =>
        messages.filter((row) => row.role === role).flatMap((row) => (collapse(row.text) === "" ? [] : [clamp(collapse(row.text), DIGEST_CHARS)]));
    return {
        messages: messages.length,
        asked: spoken("user").slice(0, DIGEST_PROMPTS),
        ...present({ lastSaid: spoken("assistant").at(-1), lastNotice: spoken("notice").at(-1) }),
        ...noticeAge(messages),
    };
};

// What its spend figures are worth. `unrecorded`: it ran turns or used tools, yet no turn of it reported a token or a
// cent (a turn that failed, or that a restart cut, before its usage arrived; a runtime that reports none), so the zeros
// are not a measurement and are not printed as one. `unpriced`: tokens were counted, but its provider names no price.
export type FleetUsage = "recorded" | "unpriced" | "unrecorded";

// Everything about one conversation, assembled into a single answer.
export interface FleetRecall extends FleetRow {
    readonly harness: string;
    readonly effort?: string;
    readonly account?: string;
    readonly sessionId?: string;
    readonly runner?: string;
    readonly worktree?: string;
    readonly record: string;
    // Lifetime spend with the running turn's so far, as the board shows it. Input is uncached input only: cache reads
    // and writes are not in it, which is why a long Claude conversation shows a few hundred.
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usage: FleetUsage;
    readonly toolUses?: number;
    readonly subagents?: number;
    readonly createdAt: number;
    readonly archivedAt?: number;
    readonly failure?: string;
    readonly failureCode?: string;
    readonly limitResetsAt?: number;
    readonly landedSubject?: string;
    // Where its last turn put work besides its branch (AgentSummary.reach); absent when it all stayed there.
    readonly reach?: TurnReach;
    // What is live or holding it right now; absent for a conversation at rest.
    readonly now?: FleetNow;
    readonly repoStates: readonly FleetRepo[];
    readonly digest: FleetDigest;
}

export interface RecallOptions {
    // Off skips the git spawns; answers from the registry alone, without per-repo file counts.
    readonly diff?: boolean;
}

const shown = (failure: string | undefined): string | undefined => (failure === undefined ? undefined : readableProviderText(failure));

// The last turn's failure as the board reports it, a spent allowance under the rate limit's own code.
const failureOf = (ending: Ending): Pick<FleetRecall, "failure" | "failureCode" | "limitResetsAt"> => {
    switch (ending.kind) {
        // Read as words here too, so a card that failed before the turn's own frame was cleaned reads the same.
        case "failed":
            return present({ failure: shown(ending.failure), failureCode: ending.code });
        case "limited":
            return present({ failure: shown(ending.failure), failureCode: "rate_limit", limitResetsAt: ending.resetsAt });
        default:
            return {};
    }
};

// The entry's totals are written once per turn, at its settle; the board's summary adds the running turn's so far.
const spendOf = (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
): Pick<FleetRecall, "costUsd" | "inputTokens" | "outputTokens" | "toolUses" | "usage"> => {
    const live = deps.agents.get(entry.id);
    const { totals } = entry;
    const costUsd = Math.max(totals.costUsd, live?.costUsd ?? 0);
    const inputTokens = Math.max(totals.inputTokens, live?.inputTokens ?? 0);
    const outputTokens = Math.max(totals.outputTokens, live?.outputTokens ?? 0);
    const toolUses = Math.max(totals.toolUses, live?.toolUses ?? 0);
    const counted = inputTokens + outputTokens > 0;
    const ran = totals.turns > 0 || toolUses > 0;
    const usage: FleetUsage = costUsd > 0 ? "recorded" : counted ? "unpriced" : ran ? "unrecorded" : "recorded";
    return { costUsd, inputTokens, outputTokens, toolUses, usage };
};

export const fleetRecall = async (
    deps: FleetRecallDeps,
    entry: PersistedAgent,
    historyRoot: string,
    options: RecallOptions = {},
): Promise<FleetRecall> => {
    const [repos, messages] = await Promise.all([
        repoStates(deps, entry, options.diff !== false),
        deps.transcripts.rows(entry).catch((): TranscriptRow[] => []),
    ]);
    const { placement, totals } = entry;
    const row = rowOf(deps, entry);
    return {
        ...row,
        harness: entry.profile.harness,
        record: transcriptFile(historyRoot, entry.id),
        ...spendOf(deps, entry),
        subagents: totals.subagents,
        createdAt: entry.createdAt,
        ...present({
            effort: entry.profile.effort,
            account: entry.profile.account,
            // Live session id, not the persisted column, which lags for a running first turn.
            sessionId: deps.conversations.sessionIdOf(entry.id),
            runner: placement.kind === "worktree" ? placement.runner : undefined,
            worktree: placement.kind === "worktree" ? deps.agentWorktrees.conversationDir(entry.id) : undefined,
            archivedAt: entry.archivedAt,
            landedSubject: entry.landing.message?.subject,
            reach: entry.reach,
            now: fleetNow(deps.agents.get(entry.id), deps.conversations.state(entry.id), row.running),
        }),
        ...failureOf(entry.ending),
        repoStates: repos,
        digest: digestOf(messages),
    };
};
