import { STATE_DIR } from "@intentic/sandbox-contract";
import type { Story } from "./stories";

/* A RUN is the set of stories the user selected at one moment, and it is backed by files rather than by any
 * store this extension owns: `run.json` under the run directory is written before the first turn starts, and
 * each agent writes its own `result.json` beside it. Two consequences worth stating,
 *
 *  • The run survives everything. Archive the fleet agents, discard them, close the browser, rebuild the image:
 *    the reports are still there, because nothing about them lives in the registry or in extension settings.
 *  • Registered-session status needs no store either. A run's conversation ids are DERIVED
 *    (`xt-<runId>-<slug>`), so joining a run to the fleet is a filter over GET /agents. Only a launch refusal is
 *    recorded: no session exists for the roster to describe in that case.
 *
 * The directory sits under the workspace's `.intentic`, which is outside every repo (the root repo excludes it)
 * and is bound back in SHARED for isolated turns, so every agent in a run writes into the same tree the browser
 * reads, with nothing to land and no git noise. */

export const RUNS_DIR = `${STATE_DIR}/records/artifacts/acceptance`;

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
// from run files, so its acknowledgement belongs in the same tree, it survives a reload, is shared across the
// owner's browsers, and adds no user-visible setting for a value no user would ever type.
export const SEEN_PATH = `${RUNS_DIR}/seen.json`;

// The conversationId's own regex is `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` (it lands in branch names and paths), so
// 64 characters is a hard ceiling, not a style choice.
const CONVERSATION_ID_MAX = 64;
const PREFIX = "xt";
const RUN_ID = /^r[0-9a-z]+$/;
const STORY_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHOT_PATH = /^shots\/[^/]+\.png$/i;

// The only report-relative image path that can be resolved back through /workspace/raw. Shared by structured
// result validation and rendered Markdown so the two evidence surfaces have one path boundary.
export const isShotPath = (path: string): boolean => SHOT_PATH.test(path);

// `r` + a base-36 timestamp: sortable, 8-ish characters, and readable enough to match a directory to a moment.
// Taken from the caller so this module stays pure and testable.
export const runIdAt = (epochMs: number): string => `r${epochMs.toString(36)}`;

/* The fleet conversation id for one story of one run. The run id is what must survive truncation, it is how a
 * card is attributed back to its run, so the SLUG is what gets cut when the two together would overflow. A
 * truncated slug can collide with a sibling's, which is why storiesOf() has already made slugs unique by
 * suffixing digits: the suffix sits at the end, exactly where the cut lands, so uniqueness is preserved only if
 * the cut leaves it. It does, slugs are capped at 40 characters and run ids are ~9, well inside 64. */
export const conversationIdOf = (runId: string, slug: string): string =>
    `${PREFIX}-${runId}-${slug}`.slice(0, CONVERSATION_ID_MAX).replace(/[-_]+$/, ``);

// One story's entry in run.json. `conversationId` is stored rather than re-derived so a future change to the id
// scheme cannot orphan the runs already on disk; `repo` and `group` because together they name the address the
// story was walked against (stories.ts targetKeyOf), and a report is unreadable without knowing which app that was.
export interface RunStory {
    readonly slug: string;
    readonly repo: string;
    readonly group: string;
    readonly path: string;
    readonly title: string;
    readonly conversationId: string;
    // The promise AS TESTED. A path is not a revision: keeping the text and its parsed criteria makes the run
    // self-contained, and lets the stories list refuse to paint an edited promise with an old green verdict.
    readonly content: string;
    readonly criteria: readonly string[];
}

export interface StorySnapshot extends Story {
    readonly content: string;
    readonly criteria: readonly string[];
}

export interface RunManifest {
    readonly runId: string;
    readonly createdAt: number;
    /* What the agents were pointed at, keyed by stories.ts targetKeyOf, kept because a report is unreadable a
     * week later without it. A map rather than one URL: a run can walk the marketing site's stories at :4321 and
     * the app's at :5173, and one field could only ever describe one of them. */
    readonly targets: Readonly<Record<string, string>>;
    // Project-specific instructions that shaped the turns, by repo. Kept with the evidence so Retry runs the
    // same brief even when the repo's .acceptance.md changes later.
    readonly notes: Readonly<Record<string, string>>;
    readonly provider: string;
    readonly model?: string;
    /* HOW HARD EACH SESSION THINKS, the caret's other half, recorded beside the model for the same reason it is:
     * a run fans a session out per story and Retry launches more of them later, so a tier held only in the view
     * would run the first story at the level the reader chose and every later one at the model's default.
     * Absent ⇒ the model's own default, which is what an unpinned run has always used. */
    readonly effort?: string;
    readonly stories: readonly RunStory[];
    // A POST that was refused before the fleet registered a session. Persisted because roster absence alone
    // cannot tell "not launched" from "finished and archived", and because these are the stories Retry can resume.
    readonly launchFailures: Readonly<Record<string, string>>;
}

export const runManifestOf = (params: {
    readonly runId: string;
    readonly createdAt: number;
    readonly targets: Readonly<Record<string, string>>;
    readonly notes: Readonly<Record<string, string>>;
    readonly provider: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly stories: readonly StorySnapshot[];
}): RunManifest => ({
    runId: params.runId,
    createdAt: params.createdAt,
    targets: params.targets,
    notes: params.notes,
    provider: params.provider,
    ...(params.model === undefined || params.model === `` ? {} : { model: params.model }),
    ...(params.effort === undefined || params.effort === `` ? {} : { effort: params.effort }),
    stories: params.stories.map(({ slug, repo, group, path, title, content, criteria }) => ({
        slug,
        repo,
        group,
        path,
        title,
        conversationId: conversationIdOf(params.runId, slug),
        content,
        criteria,
    })),
    launchFailures: {},
});

// Every repo a run touched, first-appearance order, the run row's subtitle, and what the report joins
// `targets` against.
export const reposOf = (manifest: RunManifest): readonly string[] => [...new Set(manifest.stories.map((story) => story.repo))];

// Whether a historical verdict still describes the promise on disk now. Unknown text is not a match: painting a
// story green requires evidence, while withholding a badge until its bounded prefetch has read the file is honest.
export const matchesStoryRevision = (story: Pick<RunStory, "content">, current: string | undefined): boolean =>
    current !== undefined && story.content === current;

// The verdict an agent writes into result.json. `blocked` is distinct from `fail` on purpose: "the app is broken
// upstream of this story" is a different report to the author than "this story's behaviour is wrong".
export type Verdict = "pass" | "fail" | "blocked";

/* The colour a verdict reads as, in the one place both the run's report and the story list can share it,
 * `blocked` is warning rather than danger because the run never got to judge the story, and a list that painted
 * "we could not reach the app" the same red as "this promise is broken" would send someone to the wrong file.
 * Plain strings: this module stays free of the UI kit, and the names are its StatusVariant's. */
const verdictTone = (verdict: Verdict): "success" | "danger" | "warning" =>
    verdict === `pass` ? `success` : verdict === `fail` ? `danger` : `warning`;

/* WHERE ONE STORY OF ONE RUN STANDS, from the two facts that answer it: what the agent WROTE, and what its
 * session is doing. Shared by the run's report and the stories list because they were deriving it separately and
 * had drifted into disagreeing about the case that matters, a session that DIED. The report called it a neutral
 * "error" beside a plain "no report was written", and the list said nothing at all, leaving a story whose test
 * never ran looking exactly like one nobody had ever tested. Both were the same wrong answer: silence.
 *
 * A verdict outranks the session, always: a story the agent judged is judged, whatever became of the session
 * afterwards. Below that, a live session is progress and a dead one is a failure of the RUN, `untested` rather
 * than `fail`, because the promise was never examined and calling that a broken promise would send the reader to
 * a file that may be perfectly fine. Undefined ⇒ nothing to show: no verdict, no session, nothing happening. */
export const storyStanding = (
    verdict: Verdict | undefined,
    status: string | undefined,
): { readonly label: string; readonly variant: "success" | "danger" | "warning" | "info" | "neutral" } | undefined => {
    if (verdict !== undefined) {
        return { label: verdict, variant: verdictTone(verdict) };
    }
    if (status === `running` || status === `awaiting`) {
        return { label: `testing`, variant: `info` };
    }
    if (status === `error`) {
        return { label: `untested`, variant: `danger` };
    }
    return undefined;
};

export interface StoryResult {
    readonly story: string;
    readonly title: string;
    readonly verdict: Verdict;
    readonly criteria: readonly { readonly text: string; readonly verdict: "pass" | "fail" | "untested"; readonly note: string }[];
    readonly steps: readonly {
        readonly n: number;
        readonly action: string;
        readonly expected: string;
        readonly observed: string;
        readonly shot: string;
    }[];
    readonly defects: readonly {
        readonly severity: "blocker" | "major" | "minor";
        readonly summary: string;
        readonly repro: string;
        readonly shot: string;
    }[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === `object` && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const nonempty = (value: unknown): value is string => typeof value === `string` && value !== ``;
const isString = (value: unknown): value is string => typeof value === `string`;
const verdict = (value: unknown): value is Verdict => value === `pass` || value === `fail` || value === `blocked`;

const criterionResult = (value: unknown): StoryResult["criteria"][number] | undefined => {
    const found = record(value);
    if (found === undefined) {
        return undefined;
    }
    const { text: criterion, verdict: result, note } = found;
    if (!nonempty(criterion) || (result !== `pass` && result !== `fail` && result !== `untested`) || !isString(note)) {
        return undefined;
    }
    return { text: criterion, verdict: result, note };
};

const stepResult = (value: unknown): StoryResult["steps"][number] | undefined => {
    const found = record(value);
    if (found === undefined) {
        return undefined;
    }
    const { n, action, expected, observed, shot } = found;
    if (
        typeof n !== `number` ||
        !Number.isInteger(n) ||
        n < 1 ||
        !nonempty(action) ||
        !isString(expected) ||
        !isString(observed) ||
        !isString(shot) ||
        (shot !== `` && !isShotPath(shot))
    ) {
        return undefined;
    }
    return { n, action, expected, observed, shot };
};

const defectResult = (value: unknown): StoryResult["defects"][number] | undefined => {
    const found = record(value);
    if (found === undefined) {
        return undefined;
    }
    const { severity, summary, repro, shot } = found;
    if (
        (severity !== `blocker` && severity !== `major` && severity !== `minor`) ||
        !nonempty(summary) ||
        !isString(repro) ||
        !isString(shot) ||
        (shot !== `` && !isShotPath(shot))
    ) {
        return undefined;
    }
    return { severity, summary, repro, shot };
};

const parsedArray = <T>(value: unknown, parse: (entry: unknown) => T | undefined): readonly T[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const parsed = value.map(parse);
    return parsed.some((entry) => entry === undefined) ? undefined : (parsed as T[]);
};

/* A result is MODEL OUTPUT, not a trusted wire response. The shape in the brief is enforced here, including the
 * authored criteria recorded in the manifest: a bare `{ "verdict": "pass" }` is not acceptance evidence, and
 * neither is a result that silently dropped or paraphrased one of the promises it was asked to judge. */
export const parseResult = (source: string, expected: Pick<RunStory, "slug" | "title" | "criteria">): StoryResult | undefined => {
    try {
        const parsed = record(JSON.parse(source));
        if (parsed === undefined) {
            return undefined;
        }
        const { story, title, verdict: result, criteria: rawCriteria, steps: rawSteps, defects: rawDefects } = parsed;
        if (!nonempty(story) || !nonempty(title) || !verdict(result)) {
            return undefined;
        }
        const criteria = parsedArray(rawCriteria, criterionResult);
        const steps = parsedArray(rawSteps, stepResult);
        const defects = parsedArray(rawDefects, defectResult);
        if (criteria === undefined || steps === undefined || defects === undefined || criteria.length === 0) {
            return undefined;
        }
        if (story !== expected.slug || title !== expected.title) {
            return undefined;
        }
        if (
            expected.criteria.length > 0 &&
            (criteria.length !== expected.criteria.length || criteria.some((entry, index) => entry.text !== expected.criteria[index]))
        ) {
            return undefined;
        }
        if (result === `pass` && criteria.some((entry) => entry.verdict !== `pass`)) {
            return undefined;
        }
        if (result === `blocked` && criteria.some((entry) => entry.verdict !== `untested`)) {
            return undefined;
        }
        return { story, title, verdict: result, criteria, steps, defects };
    } catch {
        return undefined;
    }
};

const runStory = (value: unknown): RunStory | undefined => {
    const found = record(value);
    if (found === undefined) {
        return undefined;
    }
    const { slug, repo, group, path, title, conversationId, content, criteria } = found;
    if (
        !nonempty(slug) ||
        !STORY_SLUG.test(slug) ||
        !nonempty(repo) ||
        typeof group !== `string` ||
        !nonempty(path) ||
        !nonempty(title) ||
        !nonempty(conversationId) ||
        !CONVERSATION_ID.test(conversationId) ||
        typeof content !== `string` ||
        !Array.isArray(criteria) ||
        !criteria.every(nonempty)
    ) {
        return undefined;
    }
    return {
        slug,
        repo,
        group,
        path,
        title,
        conversationId,
        content,
        criteria,
    };
};

const stringRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
    const found = record(value);
    return found === undefined || Object.values(found).some((entry) => typeof entry !== `string`) ? undefined : (found as Record<string, string>);
};

/* A run.json that is half-written or malformed is skipped rather than allowed to manufacture paths, sessions or
 * verdicts. There is no permissive fallback: a run is evidence, so all of the facts needed to interpret it must
 * have been written atomically in the manifest. */
export const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const parsed = record(JSON.parse(text));
        if (parsed === undefined) {
            return undefined;
        }
        const {
            runId,
            createdAt,
            provider,
            model,
            effort,
            stories: rawStories,
            targets: rawTargets,
            notes: rawNotes,
            launchFailures: rawLaunchFailures,
        } = parsed;
        if (
            !nonempty(runId) ||
            !RUN_ID.test(runId) ||
            typeof createdAt !== `number` ||
            !Number.isSafeInteger(createdAt) ||
            createdAt < 0 ||
            !nonempty(provider) ||
            (model !== undefined && !nonempty(model)) ||
            (effort !== undefined && !nonempty(effort)) ||
            !Array.isArray(rawStories) ||
            rawStories.length === 0
        ) {
            return undefined;
        }
        const targets = stringRecord(rawTargets);
        const notes = stringRecord(rawNotes);
        const launchFailures = stringRecord(rawLaunchFailures);
        const stories = rawStories.map(runStory);
        if (targets === undefined || notes === undefined || launchFailures === undefined || stories.some((story) => story === undefined)) {
            return undefined;
        }
        const complete = stories as RunStory[];
        if (
            new Set(complete.map((story) => story.slug)).size !== complete.length ||
            new Set(complete.map((story) => story.conversationId)).size !== complete.length ||
            complete.some((story) => story.conversationId !== conversationIdOf(runId, story.slug)) ||
            Object.entries(launchFailures).some(([slug, failure]) => failure === `` || !complete.some((story) => story.slug === slug))
        ) {
            return undefined;
        }
        return {
            runId,
            createdAt,
            targets,
            notes,
            provider,
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            stories: complete,
            launchFailures,
        };
    } catch {
        return undefined;
    }
};
