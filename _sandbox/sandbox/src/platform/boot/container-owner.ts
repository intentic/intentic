import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import type { Logger } from "pino";
import { processIdentity, type ProcessIdentity, sameProcess } from "../resources/proc-stat.js";

// Ensures one daemon per container: converging HOME, sweeping leftover processes, and holding singleton ports all
// assume a single owner. A claim on `roots` (may converge these volumes) is separate from a claim on `container` (may
// own container-wide state); a daemon started from inside an agent session claims neither.

const CLAIM_FILE = ".intentic-daemon.json";

// Marks a daemon started from inside an agent conversation; set on the process env and inherited by children.
export const AGENT_SESSION_ENV = "INTENTIC_AGENT_SESSION";

// The volumes a daemon was given: the workspace it converges and the history holding its journal and marker.
export interface DaemonRoots {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
}

export interface ContainerClaim extends DaemonRoots, ProcessIdentity {}

// What this run may claim; both false is a guest that serves without owning anything here before it.
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
        // No parseable claim exists yet; this run is free to take the container.
        return undefined;
    }
};

// Reads who holds the container right now, for anyone re-checking after boot.
export const claimHolder = (home: string = homedir()): ContainerClaim | undefined => readClaim(home);

const sameRoots = (a: DaemonRoots, b: DaemonRoots): boolean => a.workspaceRoot === b.workspaceRoot && a.historyRoot === b.historyRoot;

// Waits briefly for the live holder of these roots to finish exiting, since a restart's predecessor may still be
// shutting down; a holder on other roots returns immediately as a co-tenant.
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

// Determines whether this process may act as the container's daemon and whether it may converge its roots. Never
// throws: a HOME that cannot hold the claim file cannot be proven ours, so this runs as a guest instead.
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
