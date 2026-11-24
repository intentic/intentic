import type { PickerOption } from "@intentic/ui";
import { formatBytes, formatList } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { EngineHold, EngineMode, EngineStatus } from "../../desktopEngine";

// WHAT RUNS IN THE BACKGROUND, IN THE READER'S WORDS (BackgroundRows.vue draws them): when Intentic's engine runs, what
// each choice does to this computer's own sandboxes, and what the engine is doing now and why. Pure, so the words chosen
// for each mode and each hold are tested without a window.

/** The three, in the order they are offered: most running first. */
const MODES: readonly EngineMode[] = [`always`, `whenOpen`, `off`];

/** The mode as the value reads: "Always", "When Intentic is open", "Off". */
const modeLabel = (mode: EngineMode): string => t(`desktop.background.mode.${mode}`);

/** What it means, the one line under the value. */
export const modeMeaning = (mode: EngineMode): string => t(`desktop.background.meaning.${mode}`);

/**
 * What choosing it does, with this computer's own count of sandboxes where it is known. Unknown (the engine is down, so
 * nothing could be listed) says it of sandboxes in general; none says nothing of them.
 */
export const modeConsequence = (mode: EngineMode, sandboxes: number | undefined): string => {
    const lead = t(`desktop.background.lead.${mode}`);
    if (sandboxes === 0) {
        return lead;
    }
    const reach =
        sandboxes === undefined ? t(`desktop.background.reach.${mode}`) : t(`desktop.background.reachCount.${mode}`, { count: sandboxes }, sandboxes);
    return `${lead} ${reach}`;
};

/** The choices, each with what it does here. */
export const modeOptions = (sandboxes: number | undefined): PickerOption<EngineMode>[] =>
    MODES.map((mode) => ({ value: mode, label: modeLabel(mode), hint: modeConsequence(mode, sandboxes) }));

/** What the engine is doing now. */
export type EngineNow =
    | { readonly kind: `running` }
    | { readonly kind: `starting` }
    | { readonly kind: `stopping` }
    | { readonly kind: `held`; readonly hold: EngineHold }
    | { readonly kind: `down` };

export interface NowInput {
    readonly status: EngineStatus;
    /** Whether anything answers where the engine listens, as the page last looked; undefined before it has. */
    readonly listening: boolean | undefined;
    /** The app is starting it (a start pressed on the page's Docker card or notice). */
    readonly starting: boolean;
    /** Stop now or Start, pressed here and not yet answered. */
    readonly toggling: `stop` | `start` | undefined;
}

/** A press here first, then whether it answers, then why it is down: a hold of a kind, or none (it stopped by itself). */
export const nowOf = ({ status, listening, starting, toggling }: NowInput): EngineNow => {
    if (toggling === `stop`) {
        return { kind: `stopping` };
    }
    if (toggling === `start` || starting) {
        return { kind: `starting` };
    }
    if (listening ?? status.running) {
        return { kind: `running` };
    }
    // An ic from before kinds says only `held`, which was always a person's stop.
    const hold = status.hold ?? (status.held ? `stopped` : null);
    return hold === null ? { kind: `down` } : { kind: `held`, hold };
};

/** The state in words, and while it runs, how many sandboxes run on it and the memory WSL holds. */
export interface NowWords {
    readonly state: string;
    readonly sandboxes?: string | undefined;
    readonly memory?: string | undefined;
}

const sandboxesWords = (running: number): string =>
    running === 0 ? t(`desktop.background.now.noSandboxes`) : t(`desktop.background.now.sandboxes`, { count: running }, running);

export const nowWords = (now: EngineNow, running: number | undefined, memoryBytes: number | null | undefined): NowWords => {
    switch (now.kind) {
        case `running`:
            return {
                state: t(`desktop.background.now.running`),
                sandboxes: running === undefined ? undefined : sandboxesWords(running),
                memory: memoryBytes === null || memoryBytes === undefined ? undefined : formatBytes(memoryBytes),
            };
        case `held`:
            return { state: t(`desktop.background.now.held.${now.hold}`) };
        default:
            return { state: t(`desktop.background.now.${now.kind}`) };
    }
};

/** Stopped, with the person's own WSL distros still running: VmmemWSL stays, and its memory with it. Said by name. */
export const othersKeepWsl = (now: EngineNow, others: readonly string[] | undefined, memoryBytes: number | null | undefined): string | undefined => {
    if ((now.kind !== `held` && now.kind !== `down`) || others === undefined || others.length === 0) {
        return undefined;
    }
    const names = formatList(others);
    return memoryBytes === null || memoryBytes === undefined
        ? t(`desktop.background.now.othersKeep`, { names })
        : t(`desktop.background.now.othersHold`, { names, size: formatBytes(memoryBytes) });
};

/** The one press on the Now row: Stop now while it runs, Start while it is down. A start of the app's own has none. */
export interface NowPress {
    readonly verb: `stop` | `start`;
    /** Bright only for an engine that went down by itself: the way forward from a failure. A stop on purpose is a tool. */
    readonly tier: `boring` | `accent`;
}

export const nowPress = (now: EngineNow, toggling: `stop` | `start` | undefined): NowPress | undefined => {
    if (now.kind === `running` || toggling === `stop`) {
        return { verb: `stop`, tier: `boring` };
    }
    if (now.kind === `held` || toggling === `start`) {
        return { verb: `start`, tier: `boring` };
    }
    return now.kind === `down` ? { verb: `start`, tier: `accent` } : undefined;
};

/** Windows' Startup apps switched Intentic off while it is meant to start at sign-in: it will not, and this says so. */
export const startupSwitchedOff = (status: EngineStatus): boolean => status.mode === `always` && status.signIn?.disabledInWindows === true;

/** "Intentic keeps it updated and running" is true only where it does: always, or an ic that has no setting to say. */
export const keptRunningSaid = (mode: EngineMode | null | undefined): boolean => mode === null || mode === undefined || mode === `always`;
