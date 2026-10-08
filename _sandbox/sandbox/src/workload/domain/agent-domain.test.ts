import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { type AgentDomainDependencies, type AgentDomainView, domainMountArgv, startAgentDomain } from "./agent-domain.js";
import { agentEntrant, forgetAgentDomainEntry, isAgentDomainEntry, nsenterArgv, registerAgentDomainEntry } from "../namespace-entry.js";

const view: AgentDomainView = {
    cwd: WORKSPACE_ROOT, home: "/home/agent", scratch: `${HISTORY_ROOT}/domain-anchors`,
    script: (user) => `mount --bind -o X-mount.idmap=${user} /source /work`,
};

let nextPid = 51_000;
const fakeHolder = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
        pid: nextPid++, stdin: null, stdout, stderr,
        exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        unref: () => {},
    });
    return child;
};

const fixture = (options: { readonly failedMount?: boolean; readonly children?: readonly number[]; readonly readyOutput?: (marker: string) => string } = {}) => {
    const holders: ReturnType<typeof fakeHolder>[] = [];
    const calls: string[] = [];
    const argv: string[][] = [];
    const anchorPid = nextPid++;
    const deps: AgentDomainDependencies = {
        lease: async () => ({
            directory: `${HISTORY_ROOT}/domain-anchors/anchor-1`,
            release: async () => { calls.push("release"); },
            remove: async () => { calls.push("remove"); },
        }),
        start: (args) => {
            const child = fakeHolder();
            holders.push(child);
            argv.push([...args]);
            queueMicrotask(() => {
                if (holders.length === 2 && child === holders[1] && options.failedMount === true) {
                    child.stderr.write("idmap not supported");
                    Object.assign(child, { exitCode: 1 });
                    child.emit("exit", 1, null);
                } else {
                    const marker = child === holders[0] ? "agent-user-ready" : "agent-domain-ready";
                    child.stdout.write(options.readyOutput?.(marker) ?? `${marker}\n`);
                }
            });
            return child;
        },
        children: async () => options.children ?? [anchorPid],
        stop: (child) => {
            if (child.exitCode !== null || child.signalCode !== null) { return; }
            calls.push(`stop:${String(child.pid)}`);
            const holder = holders.find((candidate) => candidate === child);
            if (holder === undefined) { throw new Error("not our holder"); }
            Object.assign(holder, { signalCode: "SIGKILL" });
            holder.emit("exit", null, "SIGKILL");
        },
        warn: (error) => { throw error; },
    };
    const exit = (index: number) => {
        Object.assign(holders[index]!, { exitCode: 0 });
        holders[index]!.emit("exit", 0, null);
    };
    return { deps, holders, anchorPid, calls, argv, exit };
};

test("mount/PID setup is separate from the userns and preserves a root-only lease outside masked history", () => {
    const args = domainMountArgv(view, "/proc/41/ns/user", `${HISTORY_ROOT}/domain-anchors/anchor-1`);
    expect(args.slice(0, 5)).toEqual(["--mount", "--propagation", "private", "sh", "-c"]);
    expect(args[5]).toBe([
        "set -eu",
        "mount --make-rprivate /",
        "test ! -L /mnt/intentic-domain-lease",
        "mkdir -p /mnt/intentic-domain-lease",
        "mount --bind /history/domain-anchors/anchor-1 /mnt/intentic-domain-lease",
        "mount --bind -o X-mount.idmap=/proc/41/ns/user /source /work",
        "mkdir -p /run/intentic-domain",
        "mount --move /mnt/intentic-domain-lease /run/intentic-domain",
        "exec unshare --pid --fork --kill-child=SIGKILL --mount-proc sh -c 'held=\"$1\"\ntrap '\\''exit 0'\\'' TERM INT\nprintf '\\''%s\\n'\\'' agent-domain-ready\nwhile :; do\n  sleep 1\n  [ -e \"$held\" ] && continue\n  set -- /proc/[0-9]*\n  [ \"$#\" -le 1 ] && exit 0\ndone' anchor /run/intentic-domain/held",
    ].join("\n"));
});

test("turn disposal releases once but keeps holders and entry for surviving background children", async () => {
    const f = fixture();
    const anchor = await startAgentDomain(view, f.deps);
    expect([anchor.pid, anchor.userPid, anchor.cwd]).toEqual([f.anchorPid, f.holders[0]!.pid, "/work"]);
    expect(isAgentDomainEntry(anchor.pid)).toBe(true);
    anchor.dispose();
    anchor.dispose();
    expect(f.calls).toEqual(["release"]);
    expect(anchor.namespace.pid).toBe(anchor.pid);
    expect(agentEntrant(anchor.namespace, "/work", "true", []).args.slice(0, 2)).toEqual([
        `--target=${String(anchor.pid)}`, `--user=/proc/${String(anchor.userPid)}/ns/user`,
    ]);
    f.exit(1);
    expect(f.calls).toEqual(["release", `stop:${String(anchor.userPid)}`, "remove"]);
    expect(() => nsenterArgv(anchor.namespace, "/work", "true", [])).toThrow("reference is not registered");
    expect(() => nsenterArgv(anchor.pid, "/work", "true", [])).toThrow("not registered");
    anchor.dispose();
    expect(f.calls).toEqual(["release", `stop:${String(anchor.userPid)}`, "remove"]);
});

test("a failed lease release can be retried without killing background holders or duplicating an in-flight release", async () => {
    const f = fixture();
    const lease = await f.deps.lease(view.scratch);
    const failure = new Error("temporary unlink failure");
    const warnings: unknown[] = [];
    let attempts = 0;
    let rejectRelease: (error: Error) => void = () => { throw new Error("release was not attempted"); };
    const firstRelease = new Promise<void>((_, reject) => { rejectRelease = reject; });
    const anchor = await startAgentDomain(view, {
        ...f.deps,
        lease: async () => ({ ...lease, release: () => {
            attempts += 1;
            return attempts === 1 ? firstRelease : lease.release();
        } }),
        warn: (error) => { warnings.push(error); },
    });
    anchor.dispose();
    anchor.dispose();
    expect(attempts).toBe(1);
    rejectRelease(failure);
    await firstRelease.catch(() => {});
    expect(warnings).toEqual([failure]);
    expect(f.calls).toEqual([]);
    expect(isAgentDomainEntry(anchor.pid)).toBe(true);
    anchor.dispose();
    anchor.dispose();
    expect(attempts).toBe(2);
    await Promise.resolve();
    anchor.dispose();
    expect(attempts).toBe(2);
    expect(f.calls).toEqual(["release"]);
    f.exit(1);
    expect(f.calls).toEqual(["release", `stop:${String(anchor.userPid)}`, "remove"]);
});

test("setup failure kills only its own holders, reclaims staging, and never registers an entrant", async () => {
    const f = fixture({ failedMount: true });
    const cleanup: string[] = [];
    await expect(startAgentDomain({ ...view, cleanup: async () => { cleanup.push("view"); } }, f.deps))
        .rejects.toThrow("idmap not supported");
    expect(f.calls).toEqual([`stop:${String(f.holders[0]!.pid)}`, "remove"]);
    expect(cleanup).toEqual(["view"]);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
});

test("user holder loss during child discovery cannot return a dead domain", async () => {
    const f = fixture();
    const deps = { ...f.deps, children: async () => { f.exit(0); return [f.anchorPid]; } };
    await expect(startAgentDomain(view, deps)).rejects.toThrow("lost a namespace holder");
    expect(f.calls).toEqual([`stop:${String(f.holders[1]!.pid)}`, "remove"]);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
});

test.each([[], [10, 11], [-1], [Number.NaN], [1.5]].map((children) => [children] as const))("ambiguous or invalid child pids fail closed: %j", async (children) => {
    const f = fixture({ children });
    await expect(startAgentDomain(view, f.deps)).rejects.toThrow("exactly one PID namespace anchor");
    expect(f.calls).toEqual([
        `stop:${String(f.holders[1]!.pid)}`, `stop:${String(f.holders[0]!.pid)}`, "remove",
    ]);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
});

test("a registration collision never deletes somebody else's entry", async () => {
    const f = fixture();
    registerAgentDomainEntry(f.anchorPid, { userNamespace: "/proc/old/ns/user", home: "/home/old" });
    try {
        await expect(startAgentDomain(view, f.deps)).rejects.toThrow("already registered");
        expect(agentEntrant(f.anchorPid, "/work", "true", []).args.slice(0, 2)).toEqual([
            `--target=${String(f.anchorPid)}`, "--user=/proc/old/ns/user",
        ]);
    } finally { forgetAgentDomainEntry(f.anchorPid); }
});

const observedMarkers = () => {
    let userSeen: () => void = () => {};
    let domainSeen: () => void = () => {};
    const user = new Promise<void>((resolve) => { userSeen = resolve; });
    const domain = new Promise<void>((resolve) => { domainSeen = resolve; });
    return {
        user, domain,
        report: (marker: string): void => { if (marker === "agent-user-ready") { userSeen(); } else { domainSeen(); } },
    };
};

test("both domain holders require a complete ready marker line before proceeding", async () => {
    const seen = observedMarkers();
    const f = fixture({ readyOutput: (marker) => { seen.report(marker); return marker; } });
    const starting = startAgentDomain(view, f.deps);
    await seen.user;
    expect(f.holders).toHaveLength(1);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
    f.holders[0]!.stdout.write("\n");
    await seen.domain;
    expect(f.holders).toHaveLength(2);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
    f.holders[1]!.stdout.write("\n");
    const anchor = await starting;
    expect(anchor.pid).toBe(f.anchorPid);
    f.exit(1);
    expect(isAgentDomainEntry(anchor.pid)).toBe(false);
});

test("complete domain holder markers survive a long suffix in the same chunk", async () => {
    const f = fixture({ readyOutput: (marker) => `${marker}\n${"x".repeat(8192)}` });
    const anchor = await startAgentDomain(view, f.deps);
    expect(f.holders).toHaveLength(2);
    expect(anchor.pid).toBe(f.anchorPid);
    f.exit(1);
    expect(isAgentDomainEntry(anchor.pid)).toBe(false);
});

test("truncating output cannot manufacture either domain holder's ready marker", async () => {
    const seen = observedMarkers();
    const f = fixture({ readyOutput: (marker) => {
        seen.report(marker);
        return `not-${marker}\n${"x".repeat(8192 - marker.length - 1)}`;
    } });
    const starting = startAgentDomain(view, f.deps);
    await seen.user;
    expect(f.holders).toHaveLength(1);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
    f.holders[0]!.stdout.write("\nagent-user-ready\n");
    await seen.domain;
    expect(f.holders).toHaveLength(2);
    expect(isAgentDomainEntry(f.anchorPid)).toBe(false);
    f.holders[1]!.stdout.write("\nagent-domain-ready\n");
    const anchor = await starting;
    expect(anchor.pid).toBe(f.anchorPid);
    f.exit(1);
    expect(isAgentDomainEntry(anchor.pid)).toBe(false);
});

test("a lease allocation failure still releases the prepared filesystem view", async () => {
    const calls: string[] = [];
    const deps = unstubbed<AgentDomainDependencies>("domain", {
        lease: async () => { throw new Error("lease failed"); }, warn: (error) => { throw error; },
    });
    await expect(startAgentDomain({ ...view, cleanup: async () => { calls.push("view"); } }, deps)).rejects.toThrow("lease failed");
    expect(calls).toEqual(["view"]);
});
