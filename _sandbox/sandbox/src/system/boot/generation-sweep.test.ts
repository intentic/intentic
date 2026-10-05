import { daemonGeneration, DEADLINE_ENV, DETACHED_ENV, DAEMON_GEN_ENV, detachedStamp } from "../../seams/workload-stamp.js";
import { stampsOf } from "../resources/process-scan.js";
import { type GenerationCandidate, type GenerationPolicy, generationVerdict, overdueDetached } from "./generation-sweep.js";

/* What the boot pass ends of what earlier daemon runs left, and what it adopts or leaves alone. */

const NOW_GEN = "gen-now";
const OLD_GEN = "gen-old";

const policy = (overrides: Partial<GenerationPolicy> = {}): GenerationPolicy => ({
    generation: NOW_GEN,
    selfPid: 50,
    orphanParents: new Set([1, 6]),
    panePids: new Set<number>(),
    ...overrides,
});

const candidate = (overrides: Partial<GenerationCandidate> & { pid: number }): GenerationCandidate => ({
    ppid: 1,
    pgrp: overrides.pid,
    session: overrides.pid,
    comm: "node",
    generation: OLD_GEN,
    owner: "conv-1",
    ...overrides,
});

const verdict = (entry: GenerationCandidate, extra: Partial<GenerationPolicy> = {}, parents = new Map<number, number>()) =>
    generationVerdict(entry, parents, policy(extra));

test("a stamped process an earlier run left outside tmux goes", () => {
    expect(verdict(candidate({ pid: 900 }))).toEqual({ kill: true, why: "earlier-run" });
    expect(verdict(candidate({ pid: 901, owner: undefined, detached: "watch-check" }))).toEqual({ kill: true, why: "earlier-run" });
});

test("this run's processes, unstamped ones and the daemon itself stay", () => {
    expect(verdict(candidate({ pid: 900, generation: NOW_GEN }))).toEqual({ kill: false, why: "this-run" });
    expect(verdict(candidate({ pid: 900, generation: undefined }))).toEqual({ kill: false, why: "unstamped" });
    // Started by an earlier run, but stamped by nothing that names whose work it is: not the daemon's to judge.
    expect(verdict(candidate({ pid: 900, owner: undefined }))).toEqual({ kill: false, why: "unstamped" });
    expect(verdict(candidate({ pid: 50 }))).toEqual({ kill: false, why: "self" });
});

test("what tmux holds is the session sweep's: a kept server's process survives the restart", () => {
    // In a pane's session, though init parents it now.
    expect(verdict(candidate({ pid: 900, session: 300 }), { panePids: new Set([300]) })).toEqual({ kill: false, why: "tmux" });
    // Under a pane by ancestry.
    expect(
        verdict(
            candidate({ pid: 900, ppid: 301, session: 900 }),
            { panePids: new Set([300]) },
            new Map([
                [900, 301],
                [301, 300],
            ]),
        ),
    ).toEqual({
        kill: false,
        why: "tmux",
    });
});

test("the programs meant to outlive the daemon are adopted, whoever started them", () => {
    for (const comm of ["Xvfb", "openbox", "openconnect", "tor", "dockerd", "containerd-shim", "llama-server"]) {
        expect(verdict(candidate({ pid: 900, comm }))).toEqual({ kill: false, why: "adopted" });
    }
});

test("an isolation anchor of an earlier run always goes: no turn survives a restart", () => {
    const anchor = candidate({ pid: 900, comm: "sleep", owner: undefined, detached: "isolation-anchor" });
    expect(verdict(anchor)).toEqual({ kill: true, why: "anchor" });
    // Even when something put it under a pane: nothing will enter its namespace again.
    expect(verdict({ ...anchor, session: 300 }, { panePids: new Set([300]) })).toEqual({ kill: true, why: "anchor" });
    expect(verdict({ ...anchor, generation: NOW_GEN })).toEqual({ kill: false, why: "this-run" });
});

// The anchors that leaked before the stamp, one per crash: known only by their shape.
test("an anchor from before the stamp is known by its whole shape, and by no part of it alone", () => {
    const legacy = candidate({
        pid: 900,
        comm: "sleep",
        generation: undefined,
        owner: undefined,
        argv: ["sleep", "infinity"],
        ownMountNamespace: true,
    });
    expect(verdict(legacy)).toEqual({ kill: true, why: "earlier-anchor" });
    expect(verdict({ ...legacy, ownMountNamespace: false })).toEqual({ kill: false, why: "unstamped" });
    const { ownMountNamespace: _unread, ...namespaceUnread } = legacy;
    expect(verdict(namespaceUnread)).toEqual({ kill: false, why: "unstamped" });
    expect(verdict({ ...legacy, argv: ["sleep", "60"] })).toEqual({ kill: false, why: "unstamped" });
    // Not orphaned: a live daemon's own anchor (a co-tenant's).
    expect(verdict({ ...legacy, ppid: 4242 })).toEqual({ kill: false, why: "unstamped" });
    // Not leading its own session: somebody's `sleep infinity` in a shell.
    expect(verdict({ ...legacy, session: 12 })).toEqual({ kill: false, why: "unstamped" });
});

test("a detached child carries what it is, this run and its deadline, and the scan reads them back", () => {
    const stamp = detachedStamp("edit-rule", 1_000.4);
    expect(stamp).toEqual({ [DETACHED_ENV]: "edit-rule", [DAEMON_GEN_ENV]: daemonGeneration(), [DEADLINE_ENV]: "1001" });
    const environ = Object.entries({ PATH: "/bin", ...stamp })
        .map(([key, value]) => `${key}=${value}`)
        .join("\0");
    expect(stampsOf(environ)).toEqual({ generation: daemonGeneration(), detached: "edit-rule", deadlineAt: 1001 });
    // A kind this build does not know is no kind, and a garbled deadline no deadline.
    expect(stampsOf(`${DETACHED_ENV}=mystery\0${DEADLINE_ENV}=soon`)).toEqual({});
});

test("a watch check or an edit rule past its own deadline is overdue, whichever run started it", () => {
    const scanned = [
        { pid: 1, stamps: { detached: "watch-check" as const, deadlineAt: 10_000 } },
        { pid: 2, stamps: { detached: "edit-rule" as const, deadlineAt: 50_000 } },
        // An anchor has no deadline of its own.
        { pid: 3, stamps: { detached: "isolation-anchor" as const } },
        // A deadline without a kind is nobody's.
        { pid: 4, stamps: { deadlineAt: 1 } },
        { pid: 5 },
    ];
    expect(overdueDetached(scanned, 45_000, 30_000)).toEqual([1]);
    expect(overdueDetached(scanned, 100_000, 30_000)).toEqual([1, 2]);
});
