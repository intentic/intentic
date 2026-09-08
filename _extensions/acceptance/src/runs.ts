import {
    type BatchRunKind,
    batchConversationId,
    batchItemDir,
    batchResultPath,
    batchRunIdAt,
    batchRunManifestPath,
    batchRunsDir,
} from "@intentic/sandbox-contract/batch-runs";
import type { Story } from "./stories";
import { type AgentRunPick, AgentRunPickSchema, isConversationId } from "@intentic/sandbox-contract";

// A run is the set of stories selected at one moment; its directory layout, run id and conversation ids are the shared
// batch-run substrate (sandbox-contract/batch-runs), file-backed to survive archiving and rebuilds, with ids derived so
// joining to the fleet is a filter over GET /agents. This file covers what's story-specific: the promise, criteria,
// targets, evidence.

const KIND: BatchRunKind = {
    runsDir: `records/artifacts/acceptance`,
    prefix: `xt`,
    // Depth of the walk for reading results, not a testing limit; shared by the badge and the view so "recent" means
    // the same thing to both.
    scanRuns: 10,
};

export const RUNS_DIR = batchRunsDir(KIND);
export const SCAN_RUNS = KIND.scanRuns;

export const storyDir = (runId: string, slug: string): string => batchItemDir(KIND, runId, slug);
export const runManifestPath = (runId: string): string => batchRunManifestPath(KIND, runId);
export const resultPath = (runId: string, slug: string): string => batchResultPath(KIND, runId, slug);
export const reportPath = (runId: string, slug: string): string => `${storyDir(runId, slug)}/report.md`;

// A file, not an extension setting, so acknowledgement lives beside the run files, survives reload, and needs no
// user-facing setting.
export const SEEN_PATH = `${RUNS_DIR}/seen.json`;

const RUN_ID = /^r[0-9a-z]+$/;
const STORY_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHOT_PATH = /^shots\/[^/]+\.png$/i;

// The only report-relative image path resolvable through /workspace/raw; shared by result validation and rendered
// markdown.
export const isShotPath = (path: string): boolean => SHOT_PATH.test(path);

export const runIdAt = (epochMs: number): string => batchRunIdAt(epochMs);

// Cuts the slug, not the run id, when the two would overflow; safe since storiesOf already suffixes slugs for
// uniqueness at the end, exactly where the cut lands, and both stay well inside 64 characters.
export const conversationIdOf = (runId: string, slug: string): string => batchConversationId(KIND, runId, slug);

// `conversationId` is stored, not re-derived, so a future id-scheme change can't orphan runs on disk; `repo`/`group`
// together name the address a story was walked against (targetKeyOf).
export interface RunStory {
    readonly slug: string;
    readonly repo: string;
    readonly group: string;
    readonly path: string;
    readonly title: string;
    readonly conversationId: string;
    // The promise as tested, not as a path; keeps the run self-contained and lets an edited story outrun its old
    // verdict.
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
    // What the agents were pointed at, keyed by targetKeyOf; a map, since one run can walk two apps in the same repo at
    // different ports.
    readonly targets: Readonly<Record<string, string>>;
    // Project instructions that shaped the turns, by repo; kept with the evidence so Retry reuses the same brief later.
    readonly notes: Readonly<Record<string, string>>;
    /* WHAT EVERY SESSION IN THIS RUN OPENS ON, as the wire spells it (contract AgentRunPickSchema): the pair,
     * and the account, harness, tier, thinking and speed the reader configured with it.
     *
     * RECORDED RATHER THAN HELD IN THE VIEW, because a run fans a session out PER STORY and Retry launches more
     * of them later, quite possibly in a browser that has been reloaded since: a choice kept in memory would run
     * the first story the way the reader asked and every later one on the sandbox's defaults. The whole pick and
     * not merely the pair, for the same reason — a fan-out whose first session thinks at Max and whose rest take
     * the model's default is not one run. */
    readonly pick: NonNullable<AgentRunPick>;
    readonly stories: readonly RunStory[];
    // A POST refused before a session registered; kept since roster absence alone can't distinguish never-launched from
    // finished-and-archived, and Retry resumes from these.
    readonly launchFailures: Readonly<Record<string, string>>;
}

export const runManifestOf = (params: {
    readonly runId: string;
    readonly createdAt: number;
    readonly targets: Readonly<Record<string, string>>;
    readonly notes: Readonly<Record<string, string>>;
    readonly pick: NonNullable<AgentRunPick>;
    readonly stories: readonly StorySnapshot[];
}): RunManifest => ({
    runId: params.runId,
    createdAt: params.createdAt,
    targets: params.targets,
    notes: params.notes,
    pick: params.pick,
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

// Every repo a run touched, first-appearance order: the run row's subtitle and what a report joins targets against.
export const reposOf = (manifest: RunManifest): readonly string[] => [...new Set(manifest.stories.map((story) => story.repo))];

// Whether a past verdict still describes the story on disk; unknown text never matches, so a badge waits rather than
// guesses.
export const matchesStoryRevision = (story: Pick<RunStory, "content">, current: string | undefined): boolean =>
    current !== undefined && story.content === current;

// `blocked` differs from `fail` on purpose: the app being broken upstream is a different report than the story itself
// misbehaving.
export type Verdict = "pass" | "fail" | "blocked";

// `blocked` reads as warning, not danger, since the run never judged the story; painting it the same red as a failed
// promise would misdirect the reader. Plain strings, so this module stays free of the UI kit.
const verdictTone = (verdict: Verdict): "success" | "danger" | "warning" =>
    verdict === `pass` ? `success` : verdict === `fail` ? `danger` : `warning`;

// A verdict always outranks the session: a judged story stays judged whatever happened to it after. Otherwise a live
// session is progress and a dead one is `untested`, not `fail`, since the promise itself was never examined.
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

// Validates model output, not a trusted response: a bare `{verdict:"pass"}`, or one that dropped or paraphrased an
// authored criterion, is not acceptance evidence.
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
        !isConversationId(conversationId) ||
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

// A half-written or malformed manifest is skipped, never given a permissive fallback, since every fact needed to
// interpret a run must already be atomic in the file.
export const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const parsed = record(JSON.parse(text));
        if (parsed === undefined) {
            return undefined;
        }
        const { runId, createdAt, stories: rawStories, targets: rawTargets, notes: rawNotes, launchFailures: rawLaunchFailures } = parsed;
        // The pick answers for itself, through the schema every other surface sends it under: both halves of the
        // pair or nothing, and each knob typed. One check here rather than a field per knob, so a manifest
        // cannot fall behind what the picker can set.
        const pick = AgentRunPickSchema.safeParse(parsed[`pick`]);
        if (
            !nonempty(runId) ||
            !RUN_ID.test(runId) ||
            typeof createdAt !== `number` ||
            !Number.isSafeInteger(createdAt) ||
            createdAt < 0 ||
            !pick.success ||
            pick.data === undefined ||
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
            pick: pick.data,
            stories: complete,
            launchFailures,
        };
    } catch {
        return undefined;
    }
};
