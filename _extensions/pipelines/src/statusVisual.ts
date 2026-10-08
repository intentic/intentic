import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { PipelineStatus } from "@intentic/sandbox-contract";
import { t } from "./i18n";

// Every way a pipeline status is drawn, in one table shared by runs, stages and jobs, so the same status is always the
// same tone. Classes are spelled out in full since Tailwind scans source text; `text-${tone}` would never reach the
// stylesheet. The two tinted marks (a stage's circle, the wash behind a job row) are drawn by the graph views from
// `variant` with the kit's tone helpers: this table is also read outside a browser (runSide.ts), where the kit can't
// load.

export interface StatusTone {
    readonly icon: IconName;
    // Icons that represent motion spin; the rest are static.
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    // Foreground only, glyphs and text.
    readonly text: string;
    // A solid dot/stripe fill.
    readonly bar: string;
}

export const STATUS_TONE: Record<PipelineStatus, StatusTone> = {
    // Static clock, muted, dashed ring, not the `running` spinner: a spinning wait misleadingly says work is happening.
    // Dashed rather than a new colour, since colour here always means an outcome and queued has none yet.
    queued: {
        icon: `clock`,
        spin: false,
        // A getter, so the word is built when read and follows the language on screen.
        get label() {
            return t(`statusVisual.status.queued`);
        },
        variant: `neutral`,
        text: `text-muted`,
        bar: `bg-muted`,
    },
    success: {
        icon: `check-circle`,
        spin: false,
        get label() {
            return t(`statusVisual.status.success`);
        },
        variant: `success`,
        text: `text-success`,
        bar: `bg-success`,
    },
    failed: {
        icon: `exclamation-circle`,
        spin: false,
        get label() {
            return t(`statusVisual.status.failed`);
        },
        variant: `danger`,
        text: `text-danger`,
        bar: `bg-danger`,
    },
    running: {
        icon: `spinner`,
        spin: true,
        get label() {
            return t(`statusVisual.status.running`);
        },
        variant: `info`,
        text: `text-info`,
        bar: `bg-info`,
    },
    canceled: {
        icon: `stop`,
        spin: false,
        get label() {
            return t(`statusVisual.status.canceled`);
        },
        variant: `neutral`,
        text: `text-subtle`,
        bar: `bg-subtle`,
    },
    skipped: {
        icon: `forward`,
        spin: false,
        get label() {
            return t(`statusVisual.status.skipped`);
        },
        variant: `neutral`,
        text: `text-subtle`,
        bar: `bg-subtle`,
    },
};

// Trigger label, humanized; `push` (the overwhelming default) gets no chip. Unknown vendor words pass through as-is
// rather than being dropped.
const triggerLabels = (): Readonly<Record<string, string>> => ({
    schedule: t(`statusVisual.trigger.scheduled`),
    merge_request_event: t(`statusVisual.trigger.mergeRequest`),
    pull_request: t(`statusVisual.trigger.pullRequest`),
    pull_request_target: t(`statusVisual.trigger.pullRequest`),
    workflow_dispatch: t(`statusVisual.trigger.manual`),
    web: t(`statusVisual.trigger.manual`),
    api: t(`statusVisual.trigger.api`),
    trigger: t(`statusVisual.trigger.trigger`),
    pipeline: t(`statusVisual.trigger.upstream`),
    parent_pipeline: t(`statusVisual.trigger.upstream`),
    workflow_run: t(`statusVisual.trigger.upstream`),
    repository_dispatch: t(`statusVisual.trigger.dispatch`),
    release: t(`statusVisual.trigger.release`),
    tag: t(`statusVisual.trigger.tag`),
});

export const triggerLabel = (trigger: string | undefined): string | undefined => {
    if (trigger === undefined || trigger === `push`) {
        return undefined;
    }
    return triggerLabels()[trigger] ?? trigger.replaceAll(`_`, ` `);
};

// CI durations are minutes-and-seconds territory; anything longer still reads fine as `73m 4s`.
export const formatDuration = (seconds: number | undefined): string | undefined => {
    if (seconds === undefined) {
        return undefined;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? t(`statusVisual.minutesSeconds`, { minutes, seconds: seconds % 60 }) : t(`statusVisual.seconds`, { seconds });
};
