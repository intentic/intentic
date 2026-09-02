import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import type { Logger } from "pino";
import { processIdentity, type ProcessIdentity, sameProcess } from "./proc-stat.js";

/* ONE CONTAINER, ONE DAEMON, and everything the second one must not do.
 *
 * A sandbox is a machine people start daemons on. This repository IS the daemon, so the agents working in here
 * run it from source to see a change work; a test harness boots one; an update races its predecessor. None of
 * that is reckless, and none of it can be answered with a rule the agent is asked to remember. The daemon has to
 * know it is not alone.
 *
 * WHAT A SECOND DAEMON BREAKS is everything held once per CONTAINER, which is a much longer list than the state
 * on its volumes:
 *
 *   - the container's HOME. Four boot jobs converge it onto this run's roots, authorized_keys from the
 *     enrollment store (platform/sync.ts), ~/.claude's session stores onto the workspace
 *     (sessions/session-store.ts), the managed ssh dir onto the history volume (capabilities/ssh-hosts.ts), the
 *     git credentials the connectors wired (capabilities/cli/git-access.ts), and every one is a whole-HOME
 *     rewrite. On 2026-07-31 19:00 a dev run that died on EADDRINUSE seconds later had already taken the live
 *     sandbox's git access down (`Permission denied (publickey)`), split every live conversation's transcript in
 *     half into /tmp, and emptied authorized_keys under the enrolled desktop's sync agent.
 *   - every process the live daemon started. The leftover sweep (platform/leftovers.ts) reads them through a
 *     stamp keyed to a boot id, and a second daemon's id matches none of them. On 2026-08-11 14:56 a dev run's
 *     first sweep reclaimed 27 processes in one pass, four agent turns mid-answer and the translator, and did
 *     it again at 15:22 from a run whose roots were safely under /tmp, because the sweep never asked about roots.
 *   - the tmux server, whose panel/agent/job sessions a boot sweep clears as a previous life's leftovers.
 *   - the singletons with one address: the translator on its fixed port, the platform registration that says
 *     where this sandbox answers, the scheduled-work timer, the drafts publisher, the CI webhook reconciler.
 *     Two of any of them is two of everything they do, a post published twice, an automation fired twice.
 *
 * SO THE CONTAINER IS CLAIMED, in HOME's own file: it names the owning pid plus its kernel start-time tick and
 * the roots that run converged HOME onto, and it dies with the container exactly like the state it guards. The
 * tick matters because the daemon commonly gets the same pid after a container restart. Two questions come
 * back, because they have different answers:
 *
 *   `container`, may I take the surfaces above? Only when nobody live holds them, and never for a daemon
 *     started from inside an agent session: that one is a probe of the code, not a replacement for the sandbox,
 *     however its roots are set and whether or not the real daemon happens to be down.
 *   `roots`, may I converge and own the volumes I was given? Only the daemon whose roots these are, so a dev
 *     run under /tmp owns its own tree completely while a run pointed at the live one converges nothing.
 *
 * A predecessor still winding through its own shutdown is not a co-tenant, so a claim on THESE roots is waited
 * out briefly before its holder is taken at its word.
 */

const CLAIM_FILE = ".intentic-daemon.json";

/* THE BADGE EVERY PROCESS AN AGENT STARTS CARRIES (agent/agent-terminals.ts sets it on the command every Bash
 * tool call runs through, so it is inherited by whatever that command forks, however many levels down). Read
 * here as "this daemon was started from inside a conversation", the one fact that cannot be recovered from
 * pids, ports or roots, and the reason a dev run of main.ts never announces itself as the sandbox. */
export const AGENT_SESSION_ENV = "INTENTIC_AGENT_SESSION";

// The volumes a daemon was given: whose workspace it converges, whose history holds its journal and marker.
export interface DaemonRoots {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
}

export interface ContainerClaim extends DaemonRoots, ProcessIdentity {}

// What this run may take. Both false is a guest: it serves, and it owns nothing that was here before it.
export interface ContainerRole {
    readonly container: boolean;
    readonly roots: boolean;
}

const claimPath = (home: string): string => join(home, CLAIM_FILE);

const readClaim = (home: string): ContainerClaim | undefined => {
    try {
        const claim = JSON.parse(readFileSync(claimPath(home), "utf8")) as Partial<ContainerClaim>;
        return typeof claim.pid === "number" &&
            typeof claim.startTimeTicks === "number" &&
            typeof claim.workspaceRoot === "string" &&
            typeof claim.historyRoot === "string"
            ? (claim as ContainerClaim)
            : undefined;
    } catch {
        // Nothing claimed it, or a claim nobody can parse, either way this run is free to take the container.
        return undefined;
    }
};

/* Who holds the container RIGHT NOW, for anyone re-asking the question after boot. `claimContainer` answers it
 * once, at the only moment it can act on the answer; the invariant companion (platform/invariant.ts) re-reads
 * it, because a claim taken from under a running daemon leaves that daemon converging HOME and sweeping
 * processes on somebody else's behalf, with nothing in the log to say so. */
export const claimHolder = (home: string = homedir()): ContainerClaim | undefined => readClaim(home);

const sameRoots = (a: DaemonRoots, b: DaemonRoots): boolean => a.workspaceRoot === b.workspaceRoot && a.historyRoot === b.historyRoot;

/* The live holder of the container, waited out when it is standing on THESE roots, the shape of a restart,
 * where the predecessor is already dying and the successor must not lock itself out of its own volumes. A
 * holder on other roots is a co-tenant on the spot: it is not going anywhere on this boot's account. */
const liveOwner = async (home: string, roots: DaemonRoots, graceMs: number): Promise<ContainerClaim | undefined> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
        const claim = readClaim(home);
        if (claim === undefined || !sameProcess(claim)) {
            return undefined;
        }
        if (!sameRoots(claim, roots) || Date.now() >= deadline) {
            return claim;
        }
        await sleep(100);
    }
};

export interface ContainerClaimOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: string;
    readonly graceMs?: number;
}

/* Whether this process may act as the container's daemon, and whether it may act on its roots. Never throws: a
 * HOME that cannot even hold the claim file cannot be shown to be ours, and refusing to converge is the
 * conservative half of that, the caller's steps stay untouched instead of running on someone else's behalf. */
export const claimContainer = async (
    roots: DaemonRoots,
    logger: Logger,
    { env = process.env, home = homedir(), graceMs = 3_000 }: ContainerClaimOptions = {},
): Promise<ContainerRole> => {
    const agentSession = env[AGENT_SESSION_ENV];
    const owner = await liveOwner(home, roots, graceMs);
    if (owner !== undefined) {
        logger.warn(
            {
                ownerPid: owner.pid,
                ownerWorkspaceRoot: owner.workspaceRoot,
                ownerHistoryRoot: owner.historyRoot,
                ...(agentSession === undefined ? {} : { agentSession }),
            },
            "another live daemon owns this container, running as a guest: claiming nothing, sweeping nothing, and leaving its processes, HOME and singletons alone",
        );
        return { container: false, roots: !sameRoots(owner, roots) };
    }
    if (agentSession !== undefined) {
        logger.warn(
            { agentSession, ...roots },
            "started from inside an agent session, running as a guest: this is a run of the code, not this sandbox's daemon, so it announces nothing and claims no container-wide singleton",
        );
        return { container: false, roots: true };
    }
    const identity = processIdentity();
    if (identity === undefined) {
        logger.warn("could not identify this process from procfs, not claiming container-wide state");
        return { container: false, roots: true };
    }
    try {
        writeFileSync(claimPath(home), JSON.stringify({ ...identity, ...roots }), { mode: 0o600 });
    } catch (error) {
        logger.warn({ err: error }, "could not claim this container, not converging session state or ssh hosts onto it");
        return { container: false, roots: true };
    }
    return { container: true, roots: true };
};
