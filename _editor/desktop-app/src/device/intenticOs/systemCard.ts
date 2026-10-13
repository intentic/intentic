import type { IntenticOsChannel, IntenticOsStatus, IntenticOsUpdateCheck } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";
import type { OsRunEnd, OsRunEvent, OsVerb } from "../../desktop";

// THIS SYSTEM, READ (src-tauri/src/os.rs runs `ic os`, system.ts holds it, SystemCard.vue draws it): what waits for the
// next boot and the press that restarts into it, the boot's health, how sandboxes are isolated, the channel the next
// boot runs, what a check found, and a change's lines as every window hears them. Pure, so each case is tested by value
// (systemCard.test.ts).

/** The two channels `ic os channel` takes, in the order the switch draws them. */
export const CHANNELS: readonly IntenticOsChannel[] = [`stable`, `beta`];

/** What waits for the next boot: an update staged (a switch of channel included), or the previous version queued. */
export type OsWaiting = `update` | `rollback`;

/** A queued rollback outranks a staged image: bootc boots the rollback deployment next. */
export const waitingOf = (status: IntenticOsStatus): OsWaiting | undefined => {
    if (status.rollbackQueued) {
        return `rollback`;
    }
    return status.staged === null ? undefined : `update`;
};

/** The version the next boot runs, when one waits and bootc says which. */
export const waitingVersionOf = (status: IntenticOsStatus): string | undefined => {
    switch (waitingOf(status)) {
        case `rollback`:
            return status.rollback?.version ?? undefined;
        case `update`:
            return status.staged?.version ?? undefined;
        default:
            return undefined;
    }
};

/**
 * The change that restarts into what waits. A staged update is applied (`ic os update --apply`, the approval the OS
 * waits for); a queued rollback is restarted into (`ic os reboot`), since `ic os rollback` again would queue the other
 * deployment back.
 */
export type OsRestart = `applyUpdate` | `reboot`;

export const restartOf = (status: IntenticOsStatus): OsRestart | undefined => {
    switch (waitingOf(status)) {
        case `update`:
            return `applyUpdate`;
        case `rollback`:
            return `reboot`;
        default:
            return undefined;
    }
};

/** The previous version can be queued: bootc kept one, and nothing else waits for the next boot. */
export const canRollBack = (status: IntenticOsStatus): boolean => status.rollback !== null && !status.rebootRequired;

/** The channel can be switched: not over a queued rollback, which the switch's staged image would take the place of. */
export const canSwitchChannel = (status: IntenticOsStatus): boolean => !status.rollbackQueued;

/** An image reference's tag: `stable` in `ghcr.io/intentic/os:stable`, none for a bare name or a digest alone. */
export const tagOf = (image: string | null | undefined): string | undefined => {
    if (image === null || image === undefined) {
        return undefined;
    }
    const named = image.split(`@`)[0] ?? ``;
    const name = named.slice(named.lastIndexOf(`/`) + 1);
    const at = name.lastIndexOf(`:`);
    return at === -1 || at === name.length - 1 ? undefined : name.slice(at + 1);
};

/** The channel the next boot runs: a staged image's tag (a switch waits for the restart), else the booted one's. */
export const nextChannelOf = (status: IntenticOsStatus): string => (status.staged === null ? undefined : tagOf(status.staged.image)) ?? status.channel;

/** One of the two channels, from whatever ic said; undefined for a tag the switch does not offer. */
export const channelOf = (value: string): IntenticOsChannel | undefined => CHANNELS.find((channel) => channel === value);

/** The boot's health as the card says it. */
export interface OsHealth {
    readonly verdict: `healthy` | `failing` | `unknown`;
    readonly tone: StatusVariant;
    /** Each check that failed, in ic's words. */
    readonly failed: readonly string[];
}

export const healthOf = (status: IntenticOsStatus): OsHealth => {
    switch (status.health.verdict) {
        case `green`:
            return { verdict: `healthy`, tone: `success`, failed: [] };
        case `red`:
            return { verdict: `failing`, tone: `danger`, failed: status.health.failed };
        default:
            return { verdict: `unknown`, tone: `neutral`, failed: [] };
    }
};

/** How sandboxes are isolated here, and whether the microVMs the policy asks for are missing (no `kata` runtime). */
export interface OsIsolation {
    readonly mode: IntenticOsStatus[`isolation`];
    readonly vmMissing: boolean;
}

export const isolationOf = (status: IntenticOsStatus): OsIsolation => ({
    mode: status.isolation,
    vmMissing: status.isolation !== `container` && !status.vmRuntime,
});

/** What a check for updates found, as the card says it. `waiting`: the version it found is the one staged already. */
export type CheckSaid = { readonly kind: `available`; readonly version: string | undefined } | { readonly kind: `current` } | { readonly kind: `waiting` };

export const checkSaidOf = (check: IntenticOsUpdateCheck | undefined, status: IntenticOsStatus): CheckSaid | undefined => {
    if (check === undefined) {
        return undefined;
    }
    if (!check.available) {
        return { kind: `current` };
    }
    if (status.staged !== null && (check.version === null || check.version === status.staged.version)) {
        return { kind: `waiting` };
    }
    return { kind: `available`, version: check.version ?? undefined };
};

/** A change under way, as the card draws it: which, and every line it printed so far (the last few hundred). */
export interface OsRunProgress {
    readonly verb: OsVerb;
    readonly apply: boolean;
    readonly channel?: IntenticOsChannel;
    readonly lines: readonly string[];
}

/** The lines a run keeps: a download prints a line every few seconds for minutes. */
export const KEPT_LINES = 400;

export const startRun = (verb: OsVerb, apply: boolean, channel?: IntenticOsChannel): OsRunProgress =>
    channel === undefined ? { verb, apply, lines: [] } : { verb, apply, channel, lines: [] };

/** One moment of a change, folded into what the card draws: undefined once it has ended (`endOf` reads how). */
export const foldRun = (progress: OsRunProgress | undefined, event: OsRunEvent): OsRunProgress | undefined => {
    switch (event.kind) {
        case `started`:
            return startRun(event.verb, event.apply, event.channel ?? undefined);
        case `line`: {
            // Heard part way through, from a window that opened after it began: its verb is all there is to go on.
            const run = progress?.verb === event.verb ? progress : startRun(event.verb, false);
            return { ...run, lines: [...run.lines, event.text].slice(-KEPT_LINES) };
        }
        default:
            return undefined;
    }
};

/** How a change ended, from its last event. */
export const endOf = (event: OsRunEvent): OsRunEnd | undefined => {
    if (event.kind !== `exit`) {
        return undefined;
    }
    const { kind: _kind, ...end } = event;
    return end;
};

/** What the card says of how a change ended: nothing for one whose result the status read after it shows. */
export type EndSaid = `restarting` | `failed` | `timedOut` | `notOs` | `busy` | undefined;

export const endSaidOf = (end: OsRunEnd | undefined): EndSaid => {
    switch (end?.outcome) {
        case `done`:
            // A restart is on its way; any other change shows itself in the status read after it.
            return end.apply ? `restarting` : undefined;
        case `failed`:
            return end.timedOut ? `timedOut` : `failed`;
        case `notOs`:
        case `busy`:
            return end.outcome;
        default:
            return undefined;
    }
};
