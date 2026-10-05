import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { sandboxNames } from "@intentic/sandbox-run";
import { baseDir } from "../config.js";
import { isProjectPairing, type Pairing, pairingKey, pairingTransport, readState, removeSandboxPairings } from "./config.js";
import { realBridgeExec, realUnbridgeFs, unbridgeRepos } from "./git-bridge.js";
import { existingSyncSessions, MUTAGEN_CALL_TIMEOUT_MS, ourForwardSessions, forwardSessionName, syncSessionNames } from "./mutagen.js";
import { listingRecordPath } from "./project-local.js";
import { forgetKnownHost, pairingSshConfig, sanitizeId, sshAlias, writeManagedSshConfig } from "./ssh.js";
import { pairingSlugs } from "./swap-pause.js";

// RETIRING A SANDBOX'S PAIRINGS (2026-10-05): everything this machine made for a sandbox that is gone, removed, and the
// owner's own files kept. The watcher does it once a sandbox has been gone past the trash window (gone.ts), and
// `intentic-machine sync forget` does it at once (what `ic sandbox remove` asks of every environment). What goes:
// - the pairings, first, so the watcher recreates nothing it is about to terminate (detach does the same);
// - its Mutagen sessions, sync and forward, by name, so a session of another sandbox is never taken along;
// - its block in the ssh config fragment (rewritten from the pairings that remain) and its line in this agent's
//   known_hosts, under every port its alias was ever bound to;
// - each pairing's hash cache (`hashes/<key>.json`, project-local.ts);
// - the bridge's `sandbox` remote, its tracking refs and its markers in the repos it followed (git-bridge.ts).
// What stays: the local folder and every restore point under `restore/<key>/`, said in the one line it logs, since
// those are the owner's and the only copy of what the sandbox held.

// Which of this machine's sandboxes a name means, exactly: its sandbox id (as written or sanitized), the slug ic knows it
// by (the first label of its public hostname, or the id in it), the slug ic once listed it under, or its container's
// name. Exact, never a substring: this answers what to delete.
export const sandboxesNamed = (pairings: readonly Pairing[], name: string): string[] => {
    const wanted = name.trim();
    if (wanted === "") {
        return [];
    }
    const matches = (pairing: Pairing): boolean =>
        pairing.sandboxId === wanted ||
        sanitizeId(pairing.sandboxId) === sanitizeId(wanted) ||
        pairingSlugs(pairing.sandboxUrl).includes(wanted) ||
        pairing.icSlug === wanted ||
        (pairing.container !== undefined && (pairing.container === wanted || pairing.container === sandboxNames(wanted).container));
    return [...new Set(pairings.filter(matches).map((pairing) => pairing.sandboxId))];
};

/** What retiring one sandbox did, for the caller's own words (the CLI prints it, the watcher logs it). */
export interface Retired {
    readonly sandboxId: string;
    // The pairing keys dropped from sync.json.
    readonly pairings: readonly string[];
    // The folders kept on this machine, with their restore points.
    readonly folders: readonly string[];
}

// The seams retirement acts through, injectable so the order and the scope are checked without Mutagen or git.
export interface RetireSeams {
    readonly mutagen: string | undefined;
    readonly unbridge?: (alias: string, localDir: string) => Promise<number>;
}

// Each session ended on its own when Mutagen did not say which exist: `sync terminate a b` fails whole on one name it
// does not hold, and a listing that did not answer is no reason to leave a gone sandbox's session running.
const terminateSyncSessions = (mutagen: string, names: readonly string[]): void => {
    const live = existingSyncSessions(mutagen, names);
    for (const batch of live === undefined ? names.map((name) => [name]) : live.length > 0 ? [live] : []) {
        spawnSync(mutagen, ["sync", "terminate", ...batch], { stdio: "ignore", windowsHide: true, timeout: MUTAGEN_CALL_TIMEOUT_MS });
    }
};

// The sandbox's forwards as Mutagen holds them, or, when it did not answer, as its pairings last recorded them.
const terminateForwards = (mutagen: string, sandboxId: string, recorded: readonly Pairing[]): void => {
    const held =
        ourForwardSessions(mutagen, sandboxId) ??
        recorded.flatMap((pairing) => (pairing.mirroredPorts ?? []).map((port) => forwardSessionName(sandboxId, port.port)));
    for (const name of held) {
        spawnSync(mutagen, ["forward", "terminate", name], { stdio: "ignore", windowsHide: true, timeout: MUTAGEN_CALL_TIMEOUT_MS });
    }
};

export const retireSandbox = async (sandboxId: string, log: Log, why: string, seams: RetireSeams): Promise<Retired | undefined> => {
    const held = (await readState()).pairings.filter((pairing) => pairing.sandboxId === sandboxId);
    if (held.length === 0) {
        return undefined;
    }
    await removeSandboxPairings(sandboxId);
    const remaining = (await readState()).pairings;
    if (seams.mutagen !== undefined) {
        terminateSyncSessions(
            seams.mutagen,
            held.filter((pairing) => pairing.mode === "sync").flatMap((pairing) => syncSessionNames(pairing)),
        );
        terminateForwards(seams.mutagen, sandboxId, held);
    }
    // The ssh side, only for a sandbox some pairing reached over ssh: a docker pairing never had a block or a key line.
    const step = async (what: string, act: () => Promise<unknown>): Promise<void> => {
        await act().catch((error: unknown) => log(`  ${sandboxId}: ${what} failed (${errorMessage(error)}); the rest of its retirement went ahead.`));
    };
    if (held.some((pairing) => pairingTransport(pairing) === "ssh")) {
        await step("rewriting the ssh configuration", async () => await writeManagedSshConfig(pairingSshConfig(remaining)));
        await step("forgetting its host key", async () => await forgetKnownHost(sandboxId));
    }
    for (const pairing of held) {
        await step("dropping its hash cache", async () => await rm(listingRecordPath(baseDir, pairingKey(pairing)), { force: true }));
    }
    const unbridge =
        seams.unbridge ?? (async (alias: string, localDir: string) => await unbridgeRepos(realBridgeExec, realUnbridgeFs, alias, localDir));
    for (const pairing of held.filter((candidate) => !isProjectPairing(candidate) && candidate.mode === "sync" && candidate.localDir !== undefined)) {
        await step("removing the git bridge's remote", async () => await unbridge(sshAlias(sandboxId), pairing.localDir ?? ""));
    }
    const folders = held.flatMap((pairing) => (pairing.localDir === undefined ? [] : [pairing.localDir]));
    log(
        `retired ${sandboxId} (${why}): its file sync, forwarded ports, ssh entry, host key, hash cache and git bridge are gone from this machine${folders.length === 0 ? "" : `; ${folders.join(", ")} and ${folders.length === 1 ? "its" : "their"} restore points are kept`}.`,
    );
    return { sandboxId, pairings: held.map(pairingKey), folders };
};
