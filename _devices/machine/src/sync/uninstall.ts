import { existsSync } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { clearWindowsRunValue } from "@intentic/local-agent";
import type { Narration } from "../cli-ui.js";
import { ensureResident } from "../resident/resident.js";
import { type Pairing, pairingKey, removePairing, type SyncState } from "./config.js";
import { runProcess } from "./exec.js";
import { retirePairingMirror, teardownAllForwards } from "./mirror.js";
import {
    MUTAGEN_CALL_TIMEOUT_MS,
    MUTAGEN_RUN_VALUE,
    retireOrphanSessions,
    startMutagenDaemon,
    syncSessionNames,
} from "./mutagen.js";
import { ownMutagenPath } from "./binary/mutagen-binary.js";
import { moveOffSharedMutagen } from "./mutagen-move.js";
import { pairingSshConfig, removeManagedSshConfig, writeManagedSshConfig } from "./ssh.js";

// THE SYNC HALF'S TEARDOWN (sync/commands.ts `sync uninstall`, and the top-level `uninstall`): the pairings given are
// unpaired, each one's sessions ended, and a sandbox none of whose pairings stay is told to forget this device. Split
// out of commands.ts, whose length is held by its baseline.

// Self-revoke this machine's enrollment (uninstall): DELETE /system/authorized-key authed by the sync token. A 404 is
// an enrollment the sandbox no longer holds; any other refusal leaves this machine's key authorized there.
export const revokeEnrollment = async (sandboxUrl: string, syncToken: string): Promise<void> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/system/authorized-key`, {
        method: "DELETE",
        headers: { "x-intentic-sync": syncToken },
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
    }
};

// The pairings that sync a folder to this device: what `sync uninstall --folders` (the app's uninstaller) ends. A
// mirror-only enrollment and the projects host, which holds no folder of its own, keep mirroring ports.
export const syncsAFolder = (pairing: Pairing): boolean => pairing.mode === "sync" && pairing.projectsHost !== true;

// The sandboxes this device leaves: those whose every pairing is being dropped. Only these are told to forget it and
// lose their forwards; one whose projects host stays (`--folders` keeps it) still mirrors over that enrollment.
export const sandboxesLeft = (dropped: readonly Pairing[], remaining: readonly Pairing[]): ReadonlySet<string> =>
    new Set(dropped.map((pairing) => pairing.sandboxId).filter((id) => !remaining.some((held) => held.sandboxId === id)));

// One dropped pairing's sessions, and its sandbox's forwards once none of its pairings stays. The pair goes together: a
// surviving backup session would keep mirroring a sandbox this device has just unpaired, writing into a folder the
// owner considers released.
const endPairingSessions = async (mutagen: string, pairing: Pairing, sandboxGoes: boolean): Promise<void> => {
    if (pairing.mode === "sync" && syncSessionNames(pairing).length > 0) {
        await runProcess(mutagen, ["sync", "terminate", ...syncSessionNames(pairing)], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS });
    }
    if (sandboxGoes) {
        await retirePairingMirror(mutagen, pairing.sandboxId);
    }
};

// Every session and forward of this agent's goes with the daemon that holds them. That daemon serves this agent's own
// data directory alone (mutagen-env.ts), whichever Mutagen binary runs it, so stopping it is always this agent's to do;
// a Mutagen of the user's own runs over its own directory and is not touched. Terminating leaves each synced folder's
// files where they are. The Run value older builds wrote for the daemon goes too (mutagen.ts MUTAGEN_RUN_VALUE).
const retireOwnMutagen = async (mutagen: string | undefined, say: Narration): Promise<void> => {
    if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (mutagen === undefined) {
        say.note("Removed the ssh-config include. This agent has no Mutagen here, so there was no daemon to stop.");
        return;
    }
    await teardownAllForwards(mutagen, say.note);
    retireOrphanSessions(mutagen, [], say.note);
    await runProcess(mutagen, ["daemon", "stop"], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS });
    say.note("Removed the ssh-config include, and stopped this agent's Mutagen daemon. The synced folders keep their files.");
};

// Unpairs `dropped` out of `state`, narrating through `say`, and answers the verdict for the caller to settle its one
// live line with. `forGood` is the top-level `uninstall`, which retires the agent whatever this device hosts.
export const uninstallPairings = async (
    say: Narration,
    state: SyncState,
    dropped: readonly Pairing[],
    { forGood = false }: { readonly forGood?: boolean } = {},
): Promise<string> => {
    // This agent's own copy, never a download (2026-10-18: one that was missing or of another version used to be
    // fetched first, so an uninstall offline or behind a proxy waited on a download to remove things). Without a copy
    // the session steps are skipped: the pairings still go, and nothing of this agent's starts their sessions again.
    const mutagen = existsSync(ownMutagenPath()) ? ownMutagenPath() : undefined;
    if (mutagen !== undefined) {
        // What older builds left in Mutagen's shared data directory moves first, so an uninstall leaves nothing of this
        // agent's there either, even where no watcher ever ran this build (mutagen-move.ts).
        await moveOffSharedMutagen(mutagen, say.note);
        // No Mutagen call starts the daemon by itself any more (mutagen-env.ts), and one that is down (the agent stopped,
        // a PC just signed in) would answer every terminate below with a failure, leaving the sessions registered to come
        // back with the next start. Started here; stopped again below once nothing is left to sync.
        startMutagenDaemon(mutagen);
    }
    const remaining = state.pairings.filter((held) => !dropped.some((pairing) => pairingKey(pairing) === pairingKey(held)));
    // One enrollment per sandbox, however many of its pairings go (its projects host and its attached folders), and only
    // once none of them stays.
    const leaving = sandboxesLeft(dropped, remaining);
    const gone = new Set<string>();
    // Self-revoke each dropped enrollment so its sandbox drops the key + token. An unreachable sandbox doesn't block
    // local teardown, but the owner is told the key is still authorized there.
    for (const pairing of dropped) {
        const sandboxGoes = leaving.has(pairing.sandboxId) && !gone.has(pairing.sandboxId);
        gone.add(pairing.sandboxId);
        if (pairing.syncToken !== undefined && sandboxGoes) {
            // Drops are sequenced so failures identify one sandbox.
            await revokeEnrollment(pairing.sandboxUrl, pairing.syncToken).catch((error: Error) =>
                say.warn(
                    `${pairing.sandboxUrl} could not be told to forget this device (${errorMessage(error)}), so its sync key is still authorized there. Remove this device from that sandbox's Devices view.`,
                ),
            );
        }
        if (mutagen !== undefined) {
            // state is a single file; serial keeps the writes ordered
            await endPairingSessions(mutagen, pairing, sandboxGoes);
        }
        // ditto
        await removePairing(pairingKey(pairing));
        say.note(`Unpaired ${pairingKey(pairing)}${pairing.localDir === undefined ? "" : `; ${pairing.localDir} is no longer synced`}.`);
    }
    if (remaining.length > 0) {
        // Sync stays: regenerate the ssh fragment for pairings still live. The agent is left running — it re-reads its
        // pairing list every tick (mirror.ts), and restarting it would drop this device's socket to every linked
        // sandbox, which is the connection an unpair asked for from a sandbox travels over. Mutagen's daemon is left
        // running too: the remaining pairings' sessions and forwards ride it.
        await writeManagedSshConfig(pairingSshConfig(remaining));
        await ensureResident(say.note, { forGood });
        return `Unpaired ${plural(dropped.length, "pairing")}. Still syncing ${plural(remaining.length, "pairing")}: ${remaining.map(pairingKey).join(", ")}.`;
    }
    // Nothing left to sync: sync's residue goes (forwards, transport, ssh include); the agent retires only when this
    // environment holds nothing at all.
    await ensureResident(say.note, { forGood });
    await removeManagedSshConfig();
    await retireOwnMutagen(mutagen, say);
    return dropped.length === 0 ? "Nothing was syncing. Removed any leftovers." : "Stopped syncing on this device.";
};
