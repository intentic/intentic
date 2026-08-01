import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { DeployServerState, DeployState } from "@intentic/sandbox-contract";
import type { IncidentTone } from "./incidents";

/* Every way a deployment state is drawn, in one table — the statusVisual.ts pattern from ext-pipelines. Class
 * strings are spelled out in full because Tailwind scans source text: `text-${tone}` would never reach the
 * stylesheet.
 *
 * `stopped` is NEUTRAL, not red, and that is the design rather than an oversight. Most stopped things were
 * stopped on purpose, so colouring them as breakage paints a board that is permanently alarming and therefore
 * unreadable — the level-vs-edge point that incidents.ts exists to make. What turns red is `unhealthy` (a
 * crash loop is never intentional) and the incident strip above the list. */

export interface StateTone {
    readonly icon: IconName;
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    readonly text: string;
    readonly dot: string;
}

export const STATE_TONE: Record<DeployState, StateTone> = {
    running: { icon: `check-circle`, spin: false, label: `Running`, variant: `success`, text: `text-success`, dot: `bg-success` },
    deploying: { icon: `spinner`, spin: true, label: `Deploying`, variant: `info`, text: `text-info`, dot: `bg-info` },
    unhealthy: { icon: `exclamation-circle`, spin: false, label: `Unhealthy`, variant: `danger`, text: `text-danger`, dot: `bg-danger` },
    stopped: { icon: `stop`, spin: false, label: `Stopped`, variant: `neutral`, text: `text-subtle`, dot: `bg-subtle` },
    unknown: { icon: `question-circle`, spin: false, label: `Unknown`, variant: `neutral`, text: `text-subtle`, dot: `bg-subtle` },
};

export const SERVER_TONE: Record<DeployServerState, StateTone> = {
    ok: { icon: `check-circle`, spin: false, label: `Ok`, variant: `success`, text: `text-success`, dot: `bg-success` },
    unreachable: { icon: `exclamation-circle`, spin: false, label: `Unreachable`, variant: `danger`, text: `text-danger`, dot: `bg-danger` },
    disabled: { icon: `stop`, spin: false, label: `Disabled`, variant: `neutral`, text: `text-subtle`, dot: `bg-subtle` },
};

// `panel` is the incident strip's own border + wash. Spelled out per tone rather than interpolated for the
// reason at the top of this file: a `border-${tone}/20` would never reach the stylesheet.
export const INCIDENT_TONE: Record<
    IncidentTone,
    { readonly text: string; readonly dot: string; readonly variant: StatusVariant; readonly panel: string }
> = {
    danger: { text: `text-danger`, dot: `bg-danger`, variant: `danger`, panel: `border-danger/20 bg-danger/5` },
    warning: { text: `text-warning`, dot: `bg-warning`, variant: `warning`, panel: `border-warning/20 bg-warning/5` },
    info: { text: `text-info`, dot: `bg-info`, variant: `info`, panel: `border-info/20 bg-info/5` },
};

// A usage gauge's colour. The thresholds are the ones an operator already thinks in: comfortable under 75,
// worth noticing past it, worth acting on past 90.
export const gaugeTone = (percent: number): string => {
    if (percent >= 90) {
        return `bg-danger`;
    }
    return percent >= 75 ? `bg-warning` : `bg-success`;
};
