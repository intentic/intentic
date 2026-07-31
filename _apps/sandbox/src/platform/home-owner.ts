import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

/* ONE CONTAINER HOME, ONE DAEMON.
 *
 * Four boot jobs converge the container's ephemeral HOME onto the volumes THIS run was given: authorized_keys
 * from the enrollment store (platform/sync.ts), ~/.claude's session stores onto the workspace
 * (sessions/session-store.ts), the managed ssh dir onto the history volume (capabilities/ssh-hosts.ts), and the
 * git credentials the connectors wired (capabilities/cli/git-access.ts). Every one of them is a whole-HOME
 * rewrite keyed on this run's roots — and HOME is shared by every process in the container, so a SECOND daemon
 * started inside it (a `tsx src/main.ts` dev run with its roots under /tmp, a stray restart) repoints all of it
 * at ITS roots, which are empty. The live daemon never notices: it holds no descriptor on any of it, and every
 * read afterwards resolves through the hijacked links.
 *
 * That is not hypothetical. 2026-07-31 19:00, a dev run that died on EADDRINUSE seconds later had already
 * taken the live sandbox's git access down (the gitlab key vanished from under ~/.ssh/intentic-hosts, so
 * `git push` answered `Permission denied (publickey)` — reported as "Push failed: could not read from remote
 * repository"), split every live conversation's transcript in half into /tmp, and emptied authorized_keys under
 * the enrolled desktop's sync agent. One boot, three subsystems, no error anywhere.
 *
 * So HOME is CLAIMED before any of it runs. The claim is HOME's own file: it names the owning pid and the roots
 * it converged HOME onto, and it dies with the container exactly like the state it guards. A daemon may
 * converge HOME when nobody holds it, when the claim names its own roots (a restart — roots decide rather than
 * pid, so a predecessor lingering through its shutdown can never lock its successor out), or when the owner is
 * gone. A LIVE owner on different roots means the HOME belongs to someone else's state: skip it, and say so in
 * the log, rather than quietly taking it.
 */

const CLAIM_FILE = ".intentic-daemon.json";

// The roots a HOME convergence is keyed on: whose session stores ~/.claude points at, and whose volume the
// managed ssh dir, the git credentials and authorized_keys are derived from.
export interface HomeRoots {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
}

interface HomeClaim extends HomeRoots {
    readonly pid: number;
}

const claimPath = (home: string): string => join(home, CLAIM_FILE);

// Signal 0 delivers nothing and only asks whether the pid is there to receive it. Every daemon in this
// container shares its pid namespace, so a live pid IS the live owner — EPERM (a process owned by someone
// else) counts as live for the same reason; only ESRCH means the owner is gone.
const running = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const readClaim = (home: string): HomeClaim | undefined => {
    try {
        return JSON.parse(readFileSync(claimPath(home), "utf8")) as HomeClaim;
    } catch {
        // Nothing claimed it, or a claim nobody can parse — either way this run is free to take HOME.
        return undefined;
    }
};

// Whether this process may converge the container's HOME onto `roots`. Never throws: a HOME that cannot even
// hold the claim file cannot be shown to be ours, and refusing to converge is the conservative half of that —
// the caller's own steps then stay untouched instead of being run on someone else's behalf.
export const claimContainerHome = (roots: HomeRoots, logger: Logger, home = homedir()): boolean => {
    const claim = readClaim(home);
    if (claim !== undefined && running(claim.pid) && (claim.workspaceRoot !== roots.workspaceRoot || claim.historyRoot !== roots.historyRoot)) {
        logger.warn(
            { ownerPid: claim.pid, ownerWorkspaceRoot: claim.workspaceRoot, ownerHistoryRoot: claim.historyRoot },
            "another live daemon owns this container's HOME — leaving its ssh keys, git credentials and session state alone",
        );
        return false;
    }
    try {
        writeFileSync(claimPath(home), JSON.stringify({ pid: process.pid, ...roots }), { mode: 0o600 });
    } catch (error) {
        logger.warn({ err: error }, "could not claim this container's HOME — not converging session state or ssh hosts onto it");
        return false;
    }
    return true;
};
