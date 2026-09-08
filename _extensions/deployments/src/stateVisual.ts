import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { DeployServerState, DeployState } from "./contract";
import type { IncidentTone } from "./incidents";

// Every deployment state's visuals, in one table (mirrors ext-pipelines' statusVisual.ts). Classes are spelled out in
// full since Tailwind scans source text; `text-${tone}` would never reach the stylesheet. `stopped` is neutral, not
// red, by design: most things are stopped on purpose, only `unhealthy` and the incident strip turn red.

export interface StateTone {
    readonly icon: IconName;
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    readonly text: string;
    readonly dot: string;
    // Left accent stripe (mirrors ext-pipelines' rowBorder), so a board can be scanned by colour down the edge.
    readonly rowBorder: string;
}

export const STATE_TONE: Record<DeployState, StateTone> = {
    running: {
        icon: `check-circle`,
        spin: false,
        label: `running`,
        variant: `success`,
        text: `text-success`,
        dot: `bg-success`,
        rowBorder: `border-l-success`,
    },
    deploying: { icon: `spinner`, spin: true, label: `deploying`, variant: `info`, text: `text-info`, dot: `bg-info`, rowBorder: `border-l-info` },
    unhealthy: {
        icon: `exclamation-circle`,
        spin: false,
        label: `unhealthy`,
        variant: `danger`,
        text: `text-danger`,
        dot: `bg-danger`,
        rowBorder: `border-l-danger`,
    },
    stopped: {
        icon: `stop`,
        spin: false,
        label: `stopped`,
        variant: `neutral`,
        text: `text-subtle`,
        dot: `bg-subtle`,
        rowBorder: `border-l-subtle/40`,
    },
    unknown: {
        icon: `question-circle`,
        spin: false,
        label: `unknown`,
        variant: `neutral`,
        text: `text-subtle`,
        dot: `bg-subtle`,
        rowBorder: `border-l-subtle/40`,
    },
};

export const SERVER_TONE: Record<DeployServerState, StateTone> = {
    ok: {
        icon: `check-circle`,
        spin: false,
        label: `ok`,
        variant: `success`,
        text: `text-success`,
        dot: `bg-success`,
        rowBorder: `border-l-success`,
    },
    unreachable: {
        icon: `exclamation-circle`,
        spin: false,
        label: `unreachable`,
        variant: `danger`,
        text: `text-danger`,
        dot: `bg-danger`,
        rowBorder: `border-l-danger`,
    },
    disabled: {
        icon: `stop`,
        spin: false,
        label: `disabled`,
        variant: `neutral`,
        text: `text-subtle`,
        dot: `bg-subtle`,
        rowBorder: `border-l-subtle/40`,
    },
};

// `panel`: the incident strip's border+wash, spelled out per tone since interpolation misses the stylesheet.
export const INCIDENT_TONE: Record<
    IncidentTone,
    { readonly text: string; readonly dot: string; readonly variant: StatusVariant; readonly panel: string }
> = {
    danger: { text: `text-danger`, dot: `bg-danger`, variant: `danger`, panel: `border-danger/20 bg-danger/5` },
    warning: { text: `text-warning`, dot: `bg-warning`, variant: `warning`, panel: `border-warning/20 bg-warning/5` },
    info: { text: `text-info`, dot: `bg-info`, variant: `info`, panel: `border-info/20 bg-info/5` },
};

// Usage gauge colour at thresholds an operator already thinks in: comfortable under 75, worth noticing past it, acting
// on past 90.
export const gaugeTone = (percent: number): string => {
    if (percent >= 90) {
        return `bg-danger`;
    }
    return percent >= 75 ? `bg-warning` : `bg-success`;
};

// Repository's last segment and tag only: a stack's services share a long registry prefix that would otherwise bury
// what differs. Full reference moves to the tooltip.
export const imageLabel = (image: string): string => image.split(`/`).at(-1) ?? image;
