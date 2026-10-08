import { shellQuote } from "@intentic/sandbox-run/quote";

// `--wd` resolves before setns, landing on the daemon's unreachable /work. `--wdns` resolves after setns, the only
// reading of /work that means the worktree. Unset the inherited shell cwd too, so it cannot name the daemon's tree.
const NO_INHERITED_CWD = ["env", "-u", "PWD", "-u", "OLDPWD"] as const;
const NO_NEW_PRIVS = ["setpriv", "--no-new-privs"] as const;

export interface SandboxEntry {
    readonly uid: number;
    readonly gid: number;
}

// The mount/PID anchor stays daemon-owned. Its separate userns holder supplies the uid map. Util-linux's two-pass
// entry joins mount/PID before user; CLI flag order does not choose the order. Creating mounts in the agent userns
// instead would give the entrant control of its masks.
export interface AgentDomainEntry {
    readonly userNamespace: string;
    readonly home: string;
}

// This object is an in-process capability, not a wire shape. Its identity is the generation: a serialized object or a
// reused numeric PID cannot recreate it. Only this module mints one; the WeakMap checks issuance and retirement.
export interface NamespaceEntryReference { readonly pid: number }
type EntryState = { readonly reference: NamespaceEntryReference; active: boolean } & (
    | { readonly kind: "domain"; readonly entry: AgentDomainEntry }
    | { readonly kind: "sandbox"; readonly entry: SandboxEntry }
    | { readonly kind: "mount" }
);
type DomainState = Extract<EntryState, { readonly kind: "domain" }>;
type SandboxState = Extract<EntryState, { readonly kind: "sandbox" }>;
type MountState = Extract<EntryState, { readonly kind: "mount" }>;
const issued = new WeakMap<NamespaceEntryReference, EntryState>();
const domains = new Map<number, DomainState>();
const sandboxes = new Map<number, SandboxState>();
const mounts = new Map<number, MountState>();
const retiredDomains = new Set<number>();

const referenceFor = (pid: number): NamespaceEntryReference => {
    if (!Number.isSafeInteger(pid) || pid <= 0) { throw new Error("namespace anchor must be a positive integer PID"); }
    if (domains.has(pid) || sandboxes.has(pid) || mounts.has(pid)) {
        throw new Error(`namespace anchor ${String(pid)} is already registered`);
    }
    return Object.freeze({ pid });
};
const checkedReference = (reference: NamespaceEntryReference): EntryState => {
    const state = issued.get(reference);
    if (state === undefined || !state.active) { throw new Error(`namespace anchor ${String(reference.pid)} reference is not registered`); }
    return state;
};

export const registerAgentDomainEntry = (anchorPid: number, entry: AgentDomainEntry): NamespaceEntryReference => {
    const reference = referenceFor(anchorPid);
    const state: DomainState = { reference, active: true, kind: "domain", entry: Object.freeze({ ...entry }) };
    issued.set(reference, state);
    domains.set(anchorPid, state);
    return reference;
};
export const forgetAgentDomainEntry = (anchorPid: number): void => {
    const state = domains.get(anchorPid);
    if (state !== undefined) { state.active = false; }
    domains.delete(anchorPid);
    retiredDomains.add(anchorPid);
};
export const isAgentDomainEntry = (anchorPid: number): boolean => domains.has(anchorPid);

export const registerSandboxEntry = (anchorPid: number, entry: SandboxEntry): NamespaceEntryReference => {
    const reference = referenceFor(anchorPid);
    const state: SandboxState = { reference, active: true, kind: "sandbox", entry: Object.freeze({ ...entry }) };
    issued.set(reference, state);
    sandboxes.set(anchorPid, state);
    return reference;
};
export const forgetSandboxEntry = (anchorPid: number): void => {
    const state = sandboxes.get(anchorPid);
    if (state !== undefined) { state.active = false; }
    sandboxes.delete(anchorPid);
};

// Only a daemon creating a fresh plain-root anchor may call this. It does NOT clear a retired-domain tombstone:
// numeric callers still refuse, while this explicitly issued root reference can safely name the fresh generation.
export const registerMountEntry = (anchorPid: number): NamespaceEntryReference => {
    const reference = referenceFor(anchorPid);
    const state: MountState = { reference, active: true, kind: "mount" };
    issued.set(reference, state);
    mounts.set(anchorPid, state);
    return reference;
};

// A disposer holding an old reference cannot retire a replacement entry that happens to have the same PID.
export const forgetNamespaceEntry = (reference: NamespaceEntryReference): void => {
    const state = issued.get(reference);
    if (state === undefined || !state.active) { return; }
    state.active = false;
    if (state.kind === "domain" && domains.get(reference.pid) === state) { forgetAgentDomainEntry(reference.pid); }
    if (state.kind === "sandbox" && sandboxes.get(reference.pid) === state) { forgetSandboxEntry(reference.pid); }
    if (state.kind === "mount" && mounts.get(reference.pid) === state) { mounts.delete(reference.pid); }
};

// Numeric entry remains for callers not yet migrated. It deliberately refuses retired domain PIDs instead of guessing
// that a recycled PID now stands for a root anchor. Callers that need generation-safe reuse must carry the reference.
const entryOf = (target: number | NamespaceEntryReference): EntryState | undefined => {
    if (typeof target !== "number") { return checkedReference(target); }
    const domain = domains.get(target);
    if (domain !== undefined) { return domain; }
    if (retiredDomains.has(target)) { throw new Error(`agent domain anchor ${String(target)} is not registered`); }
    return sandboxes.get(target);
};
const pidOf = (target: number | NamespaceEntryReference): number => typeof target === "number" ? target : target.pid;

// The optional field is a root-mode migration seam for existing descriptors/test fixtures, NOT domain admission.
// Every real anchor carries the issued reference; unprivileged admission must separately require a domain reference.
export const namespaceTargetOf = (anchor: { readonly pid: number; readonly namespace?: NamespaceEntryReference }): number | NamespaceEntryReference =>
    anchor.namespace ?? anchor.pid;

const domainJoin = (anchorPid: number, entry: AgentDomainEntry): string[] => [
    `--target=${String(anchorPid)}`, `--user=${entry.userNamespace}`, "--mount", "--pid", "--setuid=0", "--setgid=0",
];
const domainEnvironment = (entry: AgentDomainEntry): string[] => [
    ...NO_NEW_PRIVS, ...NO_INHERITED_CWD, `HOME=${entry.home}`, "USER=agent", "LOGNAME=agent", "XDG_RUNTIME_DIR=/run/user/0",
];

// An explicit domain request is never a mount-only root join, including when handed a live plain-root reference.
export const agentEntrant = (target: number | NamespaceEntryReference, cwd: string, command: string, args: readonly string[]): NamespaceEntrant => {
    const state = entryOf(target);
    if (state?.kind !== "domain") { throw new Error(`agent domain anchor ${String(pidOf(target))} is not registered`); }
    return {
        command: "nsenter",
        args: [...domainJoin(state.reference.pid, state.entry), `--wdns=${cwd}`, "--", ...domainEnvironment(state.entry), command, ...args],
    };
};

// A Bash pane's way into a domain, as the shell line the daemon's tmux server runs for its window (terminal/pane-door.ts).
// Not agentEntrant: nsenter forks to join a PID namespace, which would leave the pane's session leader outside the
// domain, and everything that finds a pane's processes by their session (tmux-run's sweep, input-wait, background jobs)
// would find none. So it enters in two steps. Still root, it joins the domain's mount and PID namespaces; `setsid
// --ctty` makes the runner the leader of a new session with the pane's terminal as its own (taking a terminal from
// another session needs CAP_SYS_ADMIN, held only before the user namespace); only then does it enter the agent's user
// namespace. The user namespace goes in as fd 9, opened before the first step, because the holder's /proc entry is
// outside the domain's /proc. Every program the root step runs is named absolutely: those come from the image's
// read-only /usr, never from a PATH entry the agent can write. The runner closes fd 9 first (bin/tmux-run).
export const PANE_USERNS_FD = 9;
export const agentPaneLine = (target: NamespaceEntryReference, cwd: string, command: string, args: readonly string[]): string => {
    const state = entryOf(target);
    if (state?.kind !== "domain") { throw new Error(`agent domain anchor ${String(pidOf(target))} is not registered`); }
    const argv = [
        "/usr/bin/nsenter", `--target=${String(state.reference.pid)}`, "--mount", "--pid", `--wdns=${cwd}`, "--",
        "/usr/bin/setsid", "--ctty",
        "/usr/bin/nsenter", `--user=/proc/self/fd/${String(PANE_USERNS_FD)}`, "--setuid=0", "--setgid=0", "--",
        ...domainEnvironment(state.entry), command, ...args,
    ];
    return `exec ${String(PANE_USERNS_FD)}<${shellQuote(state.entry.userNamespace)}; exec ${argv.map(shellQuote).join(" ")}`;
};

// A fenced turn joins all of its sandbox's namespaces, then takes its non-root uid/gid. setpriv keeps a subsequent
// exec from gaining privileges. nsenter clears supplementary groups when entering --user without preserve-credentials.
const sandboxJoin = (anchorPid: number, entry: SandboxEntry): string[] => [
    `--target=${String(anchorPid)}`, "--user", "--mount", "--pid", "--uts", "--ipc",
    `--setuid=${String(entry.uid)}`, `--setgid=${String(entry.gid)}`,
];

export interface NamespaceEntrant {
    readonly command: string;
    readonly args: string[];
}

export const nsenterArgv = (target: number | NamespaceEntryReference, cwd: string, command: string, args: readonly string[]): NamespaceEntrant => {
    const state = entryOf(target);
    if (state?.kind === "domain") { return agentEntrant(state.reference, cwd, command, args); }
    if (state?.kind === "sandbox") {
        return {
            command: "nsenter",
            args: [...sandboxJoin(state.reference.pid, state.entry), `--wdns=${cwd}`, "--", ...NO_NEW_PRIVS, ...NO_INHERITED_CWD, command, ...args],
        };
    }
    return {
        command: "nsenter",
        args: [`--mount=/proc/${String(pidOf(target))}/ns/mnt`, `--wdns=${cwd}`, "--", ...NO_INHERITED_CWD, command, ...args],
    };
};

export const nsenterPrefix = (target: number | NamespaceEntryReference, cwd: string): string => {
    const state = entryOf(target);
    if (state?.kind === "domain") {
        const entrant = agentEntrant(state.reference, cwd, "", []);
        return `${[entrant.command, ...entrant.args.slice(0, -1)].map(shellQuote).join(" ")  } `;
    }
    if (state?.kind === "sandbox") {
        return `nsenter ${sandboxJoin(state.reference.pid, state.entry).join(" ")} --wdns=${shellQuote(cwd)} -- ${NO_NEW_PRIVS.join(" ")} ${NO_INHERITED_CWD.join(" ")} `;
    }
    return `nsenter --mount=/proc/${String(pidOf(target))}/ns/mnt --wdns=${shellQuote(cwd)} -- ${NO_INHERITED_CWD.join(" ")} `;
};
