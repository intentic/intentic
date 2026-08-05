import type { Logger } from "pino";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { missingCount, type ProjectSetupStatus, startInstall, workspaceSetup } from "./workspace-setup.js";

/* THE RECONCILER — the daemon installing what a landed change made necessary, so that nobody has to be asked to.
 *
 * A turn's delta reaches the main tree through `land` (agents/land.ts), and a delta that touched a package.json
 * leaves the tree declaring dependencies that are not installed. The agent cannot fix this from inside its own
 * turn — its node_modules is an overlay whose writes die with the conversation, and pnpm's injected-deps syncer
 * throws EXDEV across that boundary anyway (agents/isolation.ts) — and asking the user to notice is asking them
 * to watch for something the machine already knows. So the machine does it.
 *
 * ONLY WHAT DRIFTED. `stale` is reconciled; `needs-setup` is not, though the same command would serve both. A
 * never-installed project is a decision the user has not made yet — the import flow offers them the install and
 * they may have declined, or dropped a reference repo they only mean to read. Installing it anyway would be this
 * surface overruling a choice. A STALE project is different in kind: nobody chose it, it is the residue of a
 * change that already landed, and putting it back is restoration rather than initiative.
 *
 * NEVER WHILE A TURN IS LIVE, and here that is a correctness rule rather than the courtesy it is for the chores
 * probe runner. Every isolated turn mounts the MAIN checkout's node_modules as the lowerdir of its own overlay,
 * and modifying a lowerdir underneath a mounted overlay is undefined behaviour in the kernel: the turn sees a
 * mixture of the old tree and the new one, with stale caches and ESTALE where files moved. An install is exactly
 * that modification, at its most violent. So a busy workspace defers, and the deferral is a retry rather than a
 * queue of what to install — by the time it fires, the tree will be re-read and whatever is true then is what
 * gets installed.
 */

// How long a deferred reconcile waits before looking again. Short enough that the install follows the last turn
// closely; long enough that a fleet finishing one turn after another does not spin. Nothing is lost by waiting —
// the drift is already in the tree and the next read finds it.
const RETRY_MS = 30_000;

export interface ReconcileDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
    // How long a deferral waits before re-reading the tree. Policy rather than a constant because it is the one
    // number here anybody would want to move — the daemon takes the default, and a case that needs to watch the
    // retry actually happen does not have to wait half a minute to see it.
    readonly retryMs?: number;
    /* The dirs whose installs this reconcile just started — the dependency verifier's cue (verify-deps.ts).
     * A callback rather than a return-value read at the call site because of the DEFERRED path: the installs
     * a busy workspace puts off start from the retry timer, minutes after the land's own frame settled, and
     * only this module knows that moment. Carried in `pending` like everything else here, so the latest
     * caller's verifier — with the latest land as its cause — is the one told. */
    readonly onInstalled?: (dirs: string[]) => void;
}

// What one reconcile decided, for the surface that reports it. `deferred` and an empty `started` is the busy
// answer — something is drifted and the install is waiting for the workspace to go quiet — which is a different
// thing to say than "nothing needed doing".
export interface ReconcileOutcome {
    readonly missing: number;
    // Mutable, because this value IS the wire frame's `deps` (events.ts infers a plain array from zod) and a
    // readonly copy would only exist to be copied back.
    readonly started: string[];
    readonly deferred: boolean;
}

const staleProjects = async (deps: ReconcileDeps): Promise<ProjectSetupStatus[]> =>
    (await workspaceSetup(deps.workspace.root, deps.processes)).filter((project) => project.state === "stale");

/* One armed retry for the whole daemon, not one per land. Ten agents landing into a busy workspace all want the
 * same thing to happen once, after the last of them.
 *
 * The LATEST caller's dependencies are what it fires with, not the first's. Arming captures a workspace root, a
 * process manager and a logger, and re-arming would otherwise be skipped while a timer from ten minutes ago
 * still held a closure over whatever the first deferral happened to be given. There is one workspace here so the
 * values rarely differ — but "rarely differs" is exactly the kind of thing that stops being true quietly. */
let retry: ReturnType<typeof setTimeout> | undefined;
let pending: ReconcileDeps | undefined;

/* Bring the main tree's installs back in line with its manifests. Returns what it decided, or undefined when
 * there was nothing to decide — the overwhelmingly common case, and the one that must cost nothing to ask about.
 *
 * Never throws: this runs at the tail of a turn that has already succeeded, and a failure to start an install is
 * not a reason to fail the turn that prompted it. The install itself reports through its own panel. */
export const reconcileDependencies = async (deps: ReconcileDeps): Promise<ReconcileOutcome | undefined> => {
    const stale = await staleProjects(deps).catch((error: unknown) => {
        deps.logger.warn({ err: error }, "dependency reconcile: could not read workspace setup");
        return [];
    });
    if (stale.length === 0) {
        return undefined;
    }
    const missing = stale.reduce((total, project) => total + missingCount(project), 0);
    if (deps.agents.liveSessionIds().length > 0) {
        pending = deps;
        if (retry === undefined) {
            retry = setTimeout(() => {
                retry = undefined;
                const next = pending;
                pending = undefined;
                if (next !== undefined) {
                    void reconcileDependencies(next);
                }
            }, deps.retryMs ?? RETRY_MS);
            retry.unref();
        }
        deps.logger.info({ projects: stale.map((project) => project.dir), missing }, "dependency reconcile deferred — a turn is live");
        return { missing, started: [], deferred: true };
    }
    // Reaching the install means the workspace went quiet, so an armed retry has nothing left to find.
    if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
        pending = undefined;
    }
    const started: string[] = [];
    for (const project of stale) {
        try {
            await startInstall(deps.workspace.root, project, deps.processes);
            started.push(project.dir);
        } catch (error) {
            deps.logger.warn({ err: error, dir: project.dir }, "dependency reconcile: install would not start");
        }
    }
    deps.logger.info({ projects: started, missing }, "dependency reconcile started");
    if (started.length > 0) {
        deps.onInstalled?.(started);
    }
    return { missing, started, deferred: false };
};
