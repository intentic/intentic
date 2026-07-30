import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { PipelineStatus } from "@intentic/sandbox-contract";

/* Every way a pipeline status is drawn, in one table. Runs, stages and jobs share the status enum, so they
 * share these tones — a failed job's card, its stage circle and its run's edge stripe are the same red by
 * construction rather than by three matching ternary chains. Class strings are spelled out in full because
 * Tailwind scans source text: `text-${tone}` would never reach the stylesheet. */

export interface StatusTone {
    readonly icon: IconName;
    // Icons that represent motion spin; the rest are static.
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    // Foreground only — glyphs and text.
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
    success: {
        icon: `check-circle`,
        spin: false,
        label: `Passed`,
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
        label: `Failed`,
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
        label: `Running`,
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
        label: `Canceled`,
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
        label: `Skipped`,
        variant: `neutral`,
        text: `text-subtle`,
        circle: `border-subtle/60 bg-subtle/10 text-subtle`,
        tint: `bg-transparent`,
        rowBorder: `border-l-subtle/40`,
        bar: `bg-subtle`,
    },
};

// CI durations are minutes-and-seconds territory; anything longer still reads fine as `73m 4s`.
export const formatDuration = (seconds: number | undefined): string | undefined => {
    if (seconds === undefined) {
        return undefined;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};
