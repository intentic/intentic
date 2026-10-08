import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { detachedStamp } from "../seams/workload-stamp.js";
import { type NamespaceEntryReference, forgetNamespaceEntry, registerAgentDomainEntry } from "./namespace-entry.js";
import { spawnAs } from "./workload-class.js";
import { namespaceHolderReady } from "./namespace-holder.js";

export const AGENT_UID = 1500;
export const AGENT_GID = 1500;
export const AGENT_HOME = "/home/agent";
export const DOMAIN_READY = "agent-domain-ready";
const USER_READY = "agent-user-ready";
const INIT_LEASE = "/run/intentic-domain";
const LEASE_STAGE = "/mnt/intentic-domain-lease";

// PID 1 is daemon-owned and outlives a released turn while its descendants run. Its lease mount remains root-only,
// outside the masked history tree. Count after sleep exits: the transient sleep must not keep the namespace alive.
export const domainInitScript = [
    `held="$1"`, `trap 'exit 0' TERM INT`, `printf '%s\\n' ${DOMAIN_READY}`,
    `while :; do`, `  sleep 1`, `  [ -e "$held" ] && continue`,
    `  set -- /proc/[0-9]*`, `  [ "$#" -le 1 ] && exit 0`, `done`,
].join("\n");

// The privileged daemon writes the maps. No setuid helper or outside uid zero is mapped into the domain.
export const agentUsernsArgv = (): string[] => [
    "--user", `--map-users=0:${String(AGENT_UID)}:1`, "--map-users=1:100000:65536",
    `--map-groups=0:${String(AGENT_GID)}:1`, "--map-groups=1:100000:65536",
    "sh", "-c", `printf '%s\\n' ${USER_READY}; exec sleep infinity`,
];

export interface AgentDomainView {
    readonly cwd: string;
    readonly home: string;
    readonly scratch: string;
    // Every idmapped bind and mask is installed in daemon-owned namespaces BEFORE an agent enters.
    readonly script: (userNamespace: string) => string;
    // Reclaim staging only when the namespace really exits, not while a released turn's children remain.
    readonly cleanup?: () => Promise<void>;
}
export interface AgentDomainAnchor {
    readonly pid: number;
    readonly namespace: NamespaceEntryReference;
    readonly userPid: number;
    readonly cwd: string;
    readonly dispose: () => void;
}

export interface DomainProcess {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly unref: () => void;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    off(event: "error", listener: (error: Error) => void): unknown;
    off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export interface DomainLease {
    readonly directory: string;
    readonly release: () => Promise<void>;
    readonly remove: () => Promise<void>;
}

// A single process/filesystem seam lets lifetime tests exercise the actual coordinator without making namespaces.
export interface AgentDomainDependencies {
    readonly lease: (scratch: string) => Promise<DomainLease>;
    readonly start: (args: readonly string[]) => DomainProcess;
    readonly children: (pid: number) => Promise<readonly number[]>;
    readonly stop: (child: DomainProcess) => void;
    readonly warn: (error: unknown) => void;
}

const createLease = async (scratch: string): Promise<DomainLease> => {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(scratch);
    if (!directoryStat.isDirectory() || directoryStat.uid !== 0 || (directoryStat.mode & 0o077) !== 0) {
        throw new Error(`agent domain scratch must be a root-owned private directory: ${scratch}`);
    }
    const directory = await mkdtemp(join(scratch, "anchor-"));
    const held = join(directory, "held");
    try {
        await writeFile(held, "", { mode: 0o600, flag: "wx" });
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        release: async () => {
            try { await unlink(held); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
            }
        },
        remove: () => rm(directory, { recursive: true, force: true }),
    };
};

const stop = (child: DomainProcess): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { return; }
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") { process.emitWarning(String(error)); }
    }
};

const dependencies: AgentDomainDependencies = {
    lease: createLease,
    start: (args) => spawnAs({ class: "service" }, "unshare", args, {
        // Setup and namespace init are privileged. Neither workspace PATH nor the daemon's credentials reach them.
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ...detachedStamp("isolation-anchor") },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
    }),
    children: async (pid) => (await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, "utf8"))
        .trim().split(/\s+/u).filter(Boolean).map(Number),
    stop,
    warn: (error) => { process.emitWarning(String(error)); },
};

// Use the same complete-line, bounded handshake as the root/fenced factories. The coordinator's exit watchers
// remain independent: losing either holder tears down the other even after a ready marker was emitted.
const ready = async (child: DomainProcess, marker: string): Promise<void> => { await namespaceHolderReady(child, marker); };

export const domainMountArgv = (view: AgentDomainView, userNamespace: string, lease: string): string[] => {
    const trailer = `exec unshare --pid --fork --kill-child=SIGKILL --mount-proc sh -c ${shellQuote(domainInitScript)} anchor ${shellQuote(join(INIT_LEASE, "held"))}`;
    return ["--mount", "--propagation", "private", "sh", "-c", [
        "set -eu",
        "mount --make-rprivate /",
        `test ! -L ${shellQuote(LEASE_STAGE)}`,
        `mkdir -p ${shellQuote(LEASE_STAGE)}`,
        `mount --bind ${shellQuote(lease)} ${shellQuote(LEASE_STAGE)}`,
        view.script(userNamespace),
        `mkdir -p ${shellQuote(INIT_LEASE)}`,
        `mount --move ${shellQuote(LEASE_STAGE)} ${shellQuote(INIT_LEASE)}`,
        trailer,
    ].join("\n")];
};

// Mount/PID namespaces belong to the daemon's user namespace; the user holder is separate. The phase-0 ordering keeps
// inherited masks locked against the entrant. Never create this view with unshare --user --mount.
export const startAgentDomain = async (
    view: AgentDomainView,
    deps: AgentDomainDependencies = dependencies,
): Promise<AgentDomainAnchor> => {
    let lease: DomainLease | undefined;
    let user: DomainProcess | undefined;
    let mounts: DomainProcess | undefined;
    let namespace: NamespaceEntryReference | undefined;
    let cleaned = false;
    let released = false;
    let releasing = false;
    const cleanup = (): void => {
        if (cleaned) { return; }
        cleaned = true;
        if (namespace !== undefined) { forgetNamespaceEntry(namespace); }
        if (mounts !== undefined) { deps.stop(mounts); }
        if (user !== undefined) { deps.stop(user); }
        void Promise.all([lease?.remove(), view.cleanup?.()]).catch(deps.warn);
    };
    const watch = (child: DomainProcess): void => {
        child.once("exit", cleanup);
        child.once("error", cleanup);
    };
    const assertLive = (): void => {
        if (cleaned || user === undefined || mounts === undefined || user.exitCode !== null || user.signalCode !== null || mounts.exitCode !== null || mounts.signalCode !== null) {
            throw new Error("agent domain lost a namespace holder during setup");
        }
    };
    try {
        lease = await deps.lease(view.scratch);
        user = deps.start(agentUsernsArgv());
        watch(user);
        await ready(user, USER_READY);
        if (cleaned || user.pid === undefined) { throw new Error("agent user namespace has no live pid"); }
        const userNamespace = `/proc/${String(user.pid)}/ns/user`;
        mounts = deps.start(domainMountArgv(view, userNamespace, lease.directory));
        watch(mounts);
        await ready(mounts, DOMAIN_READY);
        assertLive();
        if (mounts.pid === undefined) { throw new Error("agent mount namespace has no pid"); }
        const children = await deps.children(mounts.pid);
        assertLive();
        if (children.length !== 1 || !Number.isSafeInteger(children[0]) || children[0]! <= 0) {
            throw new Error("agent domain did not report exactly one PID namespace anchor");
        }
        const anchorPid = children[0]!;
        namespace = registerAgentDomainEntry(anchorPid, { userNamespace, home: view.home });
        for (const holder of [user, mounts]) {
            holder.unref();
            holder.stdout.destroy();
            holder.stderr.destroy();
        }
        const dispose = (): void => {
            if (released || releasing || cleaned) { return; }
            releasing = true;
            // Registry and holders stay alive for background children; namespace exit, not release, owns cleanup.
            // Only a confirmed unlink consumes the release. A failed attempt can be retried, but concurrent calls share it.
            void lease!.release().then(() => {
                releasing = false;
                released = true;
            }, (error: unknown) => {
                releasing = false;
                deps.warn(error);
            });
        };
        return { pid: anchorPid, namespace, userPid: user.pid, cwd: view.cwd, dispose };
    } catch (error) {
        cleanup();
        throw error;
    }
};
