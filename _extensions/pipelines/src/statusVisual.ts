import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { PipelineStatus } from "@intentic/sandbox-contract";

/* Every way a pipeline status is drawn, in one table. Runs, stages and jobs share the status enum, so they
 * share these tones, a failed job's card, its stage circle and its run's edge stripe are the same red by
 * construction rather than by three matching ternary chains. Class strings are spelled out in full because
 * Tailwind scans source text: `text-${tone}` would never reach the stylesheet. */

export interface StatusTone {
    readonly icon: IconName;
    // Icons that represent motion spin; the rest are static.
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    // Foreground only, glyphs and text.
    readonly text: string;
    // The inline stage circle: border + fill + glyph.
    readonly circle: string;
    // Wash behind a job card in the graph. DagGraph owns the card's border, so this is fill only.
    readonly tint: string;
    // The run row's left accent stripe.
    readonly rowBorder: string;
    // A solid dot/stripe fill.
    readonly bar: string;
}

export const STATUS_TONE: Record<PipelineStatus, StatusTone> = {
    /* WAITING FOR A RUNNER, and drawn as waiting: a static clock, muted ink, a dashed ring. It used to be the
     * `running` tone, spinner and all, which is the one reading a queued pipeline must never get, a board that
     * animates over work nothing is doing says "nearly there" for as long as the runner stays offline.
     *
     * Dashed rather than a fourth colour. Colour on this board already means an outcome, and queued is the
     * absence of one; the dash is the standard "not filled in yet" and separates it at a glance from `canceled`
     * and `skipped`, which share its muted palette but are over. */
    queued: {
        icon: `clock`,
        spin: false,
        label: `queued`,
        variant: `neutral`,
        text: `text-muted`,
        circle: `border-dashed border-muted/60 bg-transparent text-muted`,
        tint: `bg-transparent`,
        // At FULL opacity, unlike canceled and skipped: a stripe is how this board is scanned, and the /40 those
        // two carry disappears into the canvas. They can afford it, they are over; a run somebody is waiting on
        // has to be findable down the left edge.
        rowBorder: `border-l-muted`,
        bar: `bg-muted`,
    },
    success: {
        icon: `check-circle`,
        spin: false,
        label: `passed`,
        variant: `success`,
        text: `text-success`,
        circle: `border-success bg-success/20 text-success`,
        tint: `bg-success/5`,
        rowBorder: `border-l-success`,
        bar: `bg-success`,
    },
    failed: {
        icon: `exclamation-circle`,
        spin: false,
        label: `failed`,
        variant: `danger`,
        text: `text-danger`,
        circle: `border-danger bg-danger/20 text-danger`,
        tint: `bg-danger/5`,
        rowBorder: `border-l-danger`,
        bar: `bg-danger`,
    },
    running: {
        icon: `spinner`,
        spin: true,
        label: `running`,
        variant: `info`,
        text: `text-info`,
        circle: `border-info bg-info/20 text-info`,
        tint: `bg-info/5`,
        rowBorder: `border-l-info`,
        bar: `bg-info`,
    },
    canceled: {
        icon: `stop`,
        spin: false,
        label: `canceled`,
        variant: `neutral`,
        text: `text-subtle`,
        circle: `border-subtle/60 bg-subtle/10 text-subtle`,
        tint: `bg-transparent`,
        rowBorder: `border-l-subtle/40`,
        bar: `bg-subtle`,
    },
    skipped: {
        icon: `forward`,
        spin: false,
        label: `skipped`,
        variant: `neutral`,
        text: `text-subtle`,
        circle: `border-subtle/60 bg-subtle/10 text-subtle`,
        tint: `bg-transparent`,
        rowBorder: `border-l-subtle/40`,
        bar: `bg-subtle`,
    },
};

// A run's trigger, humanized. Push is every repo's overwhelming default, so it earns no chip, only the
// unusual origins are worth a reader's attention. Unknown vendor words pass through as-is rather than being
// dropped: a trigger we haven't seen is exactly the one worth showing.
const TRIGGER_LABEL: Record<string, string> = {
    schedule: `Scheduled`,
    merge_request_event: `Merge request`,
    pull_request: `Pull request`,
    pull_request_target: `Pull request`,
    workflow_dispatch: `Manual`,
    web: `Manual`,
    api: `API`,
    trigger: `Trigger`,
    pipeline: `Upstream`,
    parent_pipeline: `Upstream`,
    workflow_run: `Upstream`,
    repository_dispatch: `Dispatch`,
    release: `Release`,
    tag: `Tag`,
};

export const triggerLabel = (trigger: string | undefined): string | undefined => {
    if (trigger === undefined || trigger === `push`) {
        return undefined;
    }
    return TRIGGER_LABEL[trigger] ?? trigger.replaceAll(`_`, ` `);
};

// CI durations are minutes-and-seconds territory; anything longer still reads fine as `73m 4s`.
export const formatDuration = (seconds: number | undefined): string | undefined => {
    if (seconds === undefined) {
        return undefined;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};
