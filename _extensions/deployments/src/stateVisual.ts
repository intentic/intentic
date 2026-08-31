import type { IconName, StatusVariant } from "@intentic/extension-ui";
import type { DeployServerState, DeployState } from "./contract";
import type { IncidentTone } from "./incidents";

/* Every way a deployment state is drawn, in one table, the statusVisual.ts pattern from ext-pipelines. Class
 * strings are spelled out in full because Tailwind scans source text: `text-${tone}` would never reach the
 * stylesheet.
 *
 * `stopped` is NEUTRAL, not red, and that is the design rather than an oversight. Most stopped things were
 * stopped on purpose, so colouring them as breakage paints a board that is permanently alarming and therefore
 * unreadable, the level-vs-edge point that incidents.ts exists to make. What turns red is `unhealthy` (a
 * crash loop is never intentional) and the incident strip above the list. */

export interface StateTone {
    readonly icon: IconName;
    readonly spin: boolean;
    readonly label: string;
    readonly variant: StatusVariant;
    readonly text: string;
    readonly dot: string;
    // The row's left accent stripe, ext-pipelines' `rowBorder`, so a stopped container and a canceled CI run
    // are the same grey by construction. It is what lets a board be scanned by colour down its edge instead of
    // by reading a chip on every line.
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

/* What a container image reads as in a row: the repository's last segment and its tag.
 *
 * `registry.gitlab.com/radarsu/atlas/registry-api:main` becomes `registry-api:main`. Four services of one stack
 * share the first forty characters of that string, so a column of them is forty characters of identical noise
 * ahead of the eight that differ, the reader's eye has nowhere to land. The full reference is never dropped,
 * only demoted to the row's tooltip, which is where a registry host belongs: you check it when something is
 * wrong, you do not read it forty times a day. */
export const imageLabel = (image: string): string => image.split(`/`).at(-1) ?? image;
