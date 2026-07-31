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

export const RUNS_DIR = ".intentic/acceptance";

/* How many runs deep anything that READS RESULTS goes. A bound on the walk, not on what can be tested: only the
 * newest runs carry news, and a workspace with hundreds of run directories must not spend a request per story to
 * render a list or to light a badge. Shared by the rail badge's background scan and the view's own tally so the
 * two can never disagree about what "recent" means. */
export const SCAN_RUNS = 10;

const runDir = (runId: string): string => `${RUNS_DIR}/${runId}`;
export const storyDir = (runId: string, slug: string): string => `${runDir(runId)}/${slug}`;
export const runManifestPath = (runId: string): string => `${runDir(runId)}/run.json`;
export const resultPath = (runId: string, slug: string): string => `${storyDir(runId, slug)}/result.json`;
export const reportPath = (runId: string, slug: string): string => `${storyDir(runId, slug)}/report.md`;

// What the rail's badge has already been shown. A file rather than an extension setting: the badge is derived
// from run files, so its acknowledgement belongs in the same tree — it survives a reload, is shared across the
// owner's browsers, and adds no user-visible setting for a value no user would ever type.
export const SEEN_PATH = `${RUNS_DIR}/seen.json`;

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

// One story's entry in run.json. `conversationId` is stored rather than re-derived so a future change to the id
// scheme cannot orphan the runs already on disk; `repo` because a run spans repos and a report is unreadable
// without knowing which app each story was walked through.
export interface RunStory {
    readonly slug: string;
    readonly repo: string;
    readonly path: string;
    readonly title: string;
    readonly conversationId: string;
}

export interface RunManifest {
    readonly runId: string;
    readonly createdAt: number;
    /* What the agents were pointed at, PER REPO — kept because a report is unreadable a week later without it.
     * A map rather than one URL: the area is workspace-wide, so a single run can walk the frontend's stories at
     * :5173 and the API's at :3000, and one field could only ever describe one of them. */
    readonly targets: Readonly<Record<string, string>>;
    readonly provider: string;
    readonly model?: string;
    readonly stories: readonly RunStory[];
}

export const runManifestOf = (params: {
    readonly runId: string;
    readonly createdAt: number;
    readonly targets: Readonly<Record<string, string>>;
    readonly provider: string;
    readonly model?: string | undefined;
    readonly stories: readonly Story[];
}): RunManifest => ({
    runId: params.runId,
    createdAt: params.createdAt,
    targets: params.targets,
    provider: params.provider,
    ...(params.model === undefined || params.model === `` ? {} : { model: params.model }),
    stories: params.stories.map(({ slug, repo, path, title }) => ({ slug, repo, path, title, conversationId: conversationIdOf(params.runId, slug) })),
});

// Every repo a run touched, first-appearance order — the run row's subtitle, and what the report joins
// `targets` against.
export const reposOf = (manifest: RunManifest): readonly string[] => [...new Set(manifest.stories.map((story) => story.repo))];

// The verdict an agent writes into result.json. `blocked` is distinct from `fail` on purpose: "the app is broken
// upstream of this story" is a different report to the author than "this story's behaviour is wrong".
export type Verdict = "pass" | "fail" | "blocked";

/* The colour a verdict reads as, in the one place both the run's report and the story list can share it —
 * `blocked` is warning rather than danger because the run never got to judge the story, and a list that painted
 * "we could not reach the app" the same red as "this promise is broken" would send someone to the wrong file.
 * Plain strings: this module stays free of the UI kit, and the names are its StatusVariant's. */
export const verdictTone = (verdict: Verdict): "success" | "danger" | "warning" =>
    verdict === `pass` ? `success` : verdict === `fail` ? `danger` : `warning`;

export interface StoryResult {
    readonly story: string;
    readonly title?: string;
    readonly verdict: Verdict;
    readonly criteria?: readonly { readonly text: string; readonly verdict: string; readonly note?: string }[];
    readonly steps?: readonly {
        readonly n: number;
        readonly action: string;
        readonly expected?: string;
        readonly observed?: string;
        readonly shot?: string;
    }[];
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

/* A run.json that is half-written, or written by a build whose shape has since changed, is SKIPPED rather than
 * thrown on: one bad directory must not blank the whole runs list. The required core is the identity plus the
 * stories — everything else is display, and defaults quietly. */
export const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== `object` || parsed === null) {
            return undefined;
        }
        const manifest = parsed as Partial<RunManifest>;
        if (typeof manifest.runId !== `string` || !Array.isArray(manifest.stories)) {
            return undefined;
        }
        return { createdAt: 0, provider: `claude`, ...manifest, runId: manifest.runId, targets: manifest.targets ?? {}, stories: manifest.stories };
    } catch {
        return undefined;
    }
};
