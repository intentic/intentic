import type { SandboxSummary } from "@intentic/api-contract";
import { type Device, hostRunningSandbox, machinesOf } from "@intentic/sandbox-contract";
import type { CommandOs } from "@intentic/ui";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import type { ConnectionFailure } from "../live/connection";

// WHEN A SANDBOX DOESN'T COME BACK, what can still be done about it without it. Everything the recovery panel offers
// works with the daemon down: a link the desktop app on that machine answers, a command typed there, the platform's own
// rollback for a machine it runs, or another of the owner's sandboxes that can reach the same machine. Pure, so when it
// shows and what it prints are checked without mounting anything (recovery.test.ts).

// Patience before the panel: past the connecting gate's own minute, so it follows the "isn't answering" words rather
// than racing them, and past the half minute a swap takes by a wide margin when this browser asked for one.
export const RECOVERY_AFTER_MS = 2 * 60_000;
export const RESTART_RECOVERY_AFTER_MS = 3 * 60_000;

// Silence, in the shapes a sandbox that is down produces. A sign-in, a refusal or a removal is a different screen.
const QUIET: ReadonlySet<ConnectionFailure[`kind`]> = new Set([`network`, `timeout`, `closed`, `detached`]);

export interface RecoveryInput {
    readonly failure: ConnectionFailure | undefined;
    readonly reachable: boolean;
    /** How long the current run of failures has lasted. */
    readonly outageMs: number;
    /** A restart this browser asked for is still on record: the silence was expected, for a while. */
    readonly restartExpected: boolean;
    /** The machine that deleted its container said so: nothing here brings it back. */
    readonly removed: boolean;
    /** The platform refused to wake it (hours spent, hosted lane switched off): its own notice says what to do. */
    readonly refused: boolean;
    readonly hosted: boolean;
    /** Hosted only: the platform kept the image before the last change, so it can go back to it. */
    readonly canRollBack: boolean;
    /** Only the owner holds the machine, the commands and the platform's rollback. */
    readonly owner: boolean;
}

/** Whether the recovery panel is due: the owner's sandbox has been silent past the patience its situation earns. */
export const recoveryDue = (input: RecoveryInput): boolean => {
    if (input.reachable || !input.owner || input.removed || input.refused) {
        return false;
    }
    if (input.failure === undefined || !QUIET.has(input.failure.kind) || (input.hosted && !input.canRollBack)) {
        return false;
    }
    return input.outageMs >= (input.restartExpected ? RESTART_RECOVERY_AFTER_MS : RECOVERY_AFTER_MS);
};

export interface RecoveryCommands {
    /** Back to the version before the last update. */
    readonly rollback: string;
    readonly restart: string;
    /** Every link of the reachability chain, and what is broken: read-only. */
    readonly doctor: string;
}

/**
 * The three commands for the machine that runs the sandbox, in its own shell's spelling. All three go through the
 * update script, which fetches the current `ic` first (the one installed may predate what is needed, and the machine
 * agent's copy is not on the PATH). With no name known, `ic`'s bare verbs, which answer for the one sandbox on a
 * machine running only one.
 */
export const recoveryCommands = (slug: string | undefined, os: CommandOs): RecoveryCommands => {
    if (slug === undefined) {
        return { rollback: `ic sandbox rollback`, restart: `ic sandbox restart`, doctor: `ic sandbox doctor` };
    }
    return os === `windows`
        ? {
              rollback: psCommand(`updatePs1`, ``, `-Slug ${slug} -Rollback`),
              restart: psCommand(`updatePs1`, ``, `-Slug ${slug} -Restart`),
              doctor: psCommand(`updatePs1`, ``, `-Slug ${slug} -Doctor`),
          }
        : {
              rollback: bashCommand(`update`, ``, `${slug} --rollback`),
              restart: bashCommand(`update`, ``, `${slug} --restart`),
              doctor: bashCommand(`update`, ``, `${slug} --doctor`),
          };
};

/** Another of the owner's sandboxes whose Devices page can reach the machine the quiet one runs on. */
export interface SiblingManager {
    readonly sandbox: SandboxSummary;
    /** The machine as that sandbox's Devices page addresses it (`?device=`). */
    readonly machineKey: string;
    readonly machineLabel: string;
}

/**
 * The owner's other sandboxes that hold a connected, online door onto a machine whose docker reports this slug: from
 * there, Roll back and Start are one press on that machine's page. Read off each one's own device list, since whether it
 * can reach a machine is that sandbox's fact, not this one's.
 */
export const siblingManagers = (
    boxes: readonly { readonly sandbox: SandboxSummary; readonly devices: readonly Device[] }[],
    slug: string | undefined,
): SiblingManager[] =>
    slug === undefined
        ? []
        : boxes.flatMap((box) => {
              const door = box.sandbox.role === `owner` ? hostRunningSandbox(box.devices, slug) : undefined;
              const machine = door === undefined ? undefined : machinesOf(box.devices).find((each) => each.environments.some((device) => device.hostId === door));
              return machine === undefined ? [] : [{ sandbox: box.sandbox, machineKey: machine.key, machineLabel: machine.label }];
          });
