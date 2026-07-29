import type { Story } from "./stories";

/* A RUN is the set of stories the user selected at one moment, and it is backed by files rather than by any
 * store this extension owns: `run.json` under the run directory is written before the first turn starts, and
 * each agent writes its own `result.json` beside it. Two consequences worth stating —
 *
 *  • The run survives everything. Archive the fleet agents, discard them, close the browser, rebuild the image:
 *    the reports are still there, because nothing about them lives in the registry or in extension settings.
 *  • Live status needs no store either. A run's conversation ids are DERIVED (`xt-<runId>-<slug>`), so joining
 *    a run to the fleet is a filter over GET /agents, not a bookkeeping problem that can drift.
 *
 * The directory sits under the workspace's `.intentic`, which is outside every repo (the root repo excludes it)
 * and is bound back in SHARED for isolated turns — so every agent in a run writes into the same tree the browser
 * reads, with nothing to land and no git noise. */

export const RUNS_DIR = ".intentic/exploratory";

const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
export const storyDir = (runId: string, slug: string): string => `${runDir(runId)}/${slug}`;
export const runManifestPath = (runId: string): string => `${runDir(runId)}/run.json`;
export const resultPath = (runId: string, slug: string): string => `${storyDir(runId, slug)}/result.json`;
export const reportPath = (runId: string, slug: string): string => `${storyDir(runId, slug)}/report.md`;

// The conversationId's own regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` (it lands in branch names and paths), so
// 64 characters is a hard ceiling, not a style choice.
const CONVERSATION_ID_MAX = 64;
const PREFIX = "xt";

// `r` + a base-36 timestamp: sortable, 8-ish characters, and readable enough to match a directory to a moment.
// Taken from the caller so this module stays pure and testable.
export const runIdAt = (epochMs: number): string => `r${epochMs.toString(36)}`;

/* The fleet conversation id for one story of one run. The run id is what must survive truncation — it is how a
 * card is attributed back to its run — so the SLUG is what gets cut when the two together would overflow. A
 * truncated slug can collide with a sibling's, which is why storiesOf() has already made slugs unique by
 * suffixing digits: the suffix sits at the end, exactly where the cut lands, so uniqueness is preserved only if
 * the cut leaves it. It does — slugs are capped at 40 characters and run ids are ~9, well inside 64. */
export const conversationIdOf = (runId: string, slug: string): string =>
    `${PREFIX}-${runId}-${slug}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/, ``);

// Whether a fleet agent belongs to this run — the join that replaces a client-side registry.
export const isRunConversation = (runId: string, conversationId: string): boolean => conversationId.startsWith(`${PREFIX}-${runId}-`);

// One story's entry in run.json. `conversationId` is stored rather than re-derived so a future change to the id
// scheme cannot orphan the runs already on disk.
export interface RunStory {
    readonly slug: string;
    readonly path: string;
    readonly title: string;
    readonly conversationId: string;
}

export interface RunManifest {
    readonly runId: string;
    readonly repo: string;
    readonly createdAt: number;
    // What the agents were pointed at — kept because a report is unreadable a week later without it.
    readonly baseUrl: string;
    readonly provider: string;
    readonly model?: string;
    readonly stories: readonly RunStory[];
}

export const runManifestOf = (params: {
    readonly runId: string;
    readonly repo: string;
    readonly createdAt: number;
    readonly baseUrl: string;
    readonly provider: string;
    readonly model?: string | undefined;
    readonly stories: readonly Story[];
}): RunManifest => ({
    runId: params.runId,
    repo: params.repo,
    createdAt: params.createdAt,
    baseUrl: params.baseUrl,
    provider: params.provider,
    ...(params.model === undefined || params.model === `` ? {} : { model: params.model }),
    stories: params.stories.map(({ slug, path, title }) => ({ slug, path, title, conversationId: conversationIdOf(params.runId, slug) })),
});

// The verdict an agent writes into result.json. `blocked` is distinct from `fail` on purpose: "the app is broken
// upstream of this story" is a different report to the author than "this story's behaviour is wrong".
export type Verdict = "pass" | "fail" | "blocked";

export interface StoryResult {
    readonly story: string;
    readonly title?: string;
    readonly verdict: Verdict;
    readonly criteria?: readonly { readonly text: string; readonly verdict: string; readonly note?: string }[];
    readonly steps?: readonly { readonly n: number; readonly action: string; readonly expected?: string; readonly observed?: string; readonly shot?: string }[];
    readonly defects?: readonly { readonly severity: string; readonly summary: string; readonly repro?: string; readonly shot?: string }[];
}

// A result file the agent never wrote (still running, or the turn died) reads as undefined rather than as a
// verdict — the UI shows the fleet's live status for those instead of inventing one.
export const parseResult = (text: string): StoryResult | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== `object` || parsed === null) {
            return undefined;
        }
        const { verdict } = parsed as { verdict?: unknown };
        return verdict === `pass` || verdict === `fail` || verdict === `blocked` ? (parsed as StoryResult) : undefined;
    } catch {
        return undefined;
    }
};
