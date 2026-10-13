import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { ANCHOR_READY, type IsolationPlan, type MountAnchorSeams, startMountAnchor } from "./isolation.js";
import { forgetNamespaceEntry, namespaceTargetOf, nsenterArgv, registerSandboxEntry } from "../../workload/namespace-entry.js";

const FSTAB = `${HISTORY_ROOT}/overlays/abc/.mounts/test.fstab`;
// The disk a real holder needs first, stood in for: nothing here touches /history.
const released: string[] = [];
const prepare = async () => ({ fstab: FSTAB, release: async () => { released.push(FSTAB); } });
const seams = (start: NonNullable<MountAnchorSeams["start"]>, extra: Omit<MountAnchorSeams, "start" | "prepare"> = {}): MountAnchorSeams => ({ start, prepare, ...extra });

const plan: IsolationPlan = { root: WORKSPACE_ROOT, worktree: `${HISTORY_ROOT}/worktrees/abc`, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/abc`, fence: undefined };
let nextPid = 62_000;
const fixture = () => {
    const calls: string[] = [];
    const child = Object.assign(new EventEmitter(), {
        pid: nextPid++, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        stdout: new PassThrough(), stderr: new PassThrough(),
        unref: () => { calls.push("unref"); },
        kill: (signal: NodeJS.Signals) => { calls.push(`kill:${signal}`); return true; },
        stopSetup: () => { calls.push("stop-setup-group"); },
    });
    const start = (received: IsolationPlan, view: { readonly fstab: string }) => {
        expect(received).toBe(plan);
        expect(view.fstab).toBe(FSTAB);
        queueMicrotask(() => { child.stdout.write(`${ANCHOR_READY}\n`); });
        return child;
    };
    const exit = () => { child.exitCode = 0; child.emit("exit", 0, null); };
    return { child, start, exit, calls };
};

test("the real root factory returns its issued reference and disposal retires it and kills the holder once", async () => {
    const f = fixture();
    const anchor = await startMountAnchor(plan, seams(f.start));
    expect(anchor.pid).toBe(f.child.pid);
    expect(anchor.plan).toBe(plan);
    expect(anchor.cwd).toBe(plan.root);
    expect(namespaceTargetOf(anchor)).toBe(anchor.namespace!);
    expect(nsenterArgv(namespaceTargetOf(anchor), "/work", "true", [])).toEqual({ command: "nsenter", args: [
        `--mount=/proc/${String(f.child.pid)}/ns/mnt`, "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "true",
    ] });
    expect(f.calls).toEqual(["unref"]);
    anchor.dispose();
    anchor.dispose();
    expect(f.calls).toEqual(["unref", "kill:SIGKILL"]);
    expect(() => nsenterArgv(namespaceTargetOf(anchor), "/work", "true", [])).toThrow("reference is not registered");
});

test("actual root holder exit retires the reference even when its turn never called dispose", async () => {
    const f = fixture();
    const anchor = await startMountAnchor(plan, seams(f.start));
    f.exit();
    expect(() => nsenterArgv(namespaceTargetOf(anchor), "/work", "true", [])).toThrow("reference is not registered");
    anchor.dispose();
    expect(f.calls).toEqual(["unref", "kill:SIGKILL"]);
});

test("ready-then-exit refuses at the root factory before issuing a reference", async () => {
    const f = fixture();
    await expect(startMountAnchor(plan, seams(() => {
        queueMicrotask(() => { f.child.stdout.write(`${ANCHOR_READY}\n`); f.exit(); });
        return f.child;
    }))).rejects.toThrow("ended during setup");
    expect(f.calls).toEqual(["stop-setup-group"]);
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true);
});

test("a factory registration collision reclaims its own holder and never forgets the older entry", async () => {
    const f = fixture();
    const previous = registerSandboxEntry(f.child.pid, { uid: 1000, gid: 1000 });
    try {
        await expect(startMountAnchor(plan, seams(f.start))).rejects.toThrow("already registered");
        expect(f.calls).toEqual(["stop-setup-group"]);
        expect(f.child.stdout.destroyed).toBe(true);
        expect(f.child.stderr.destroyed).toBe(true);
        expect(nsenterArgv(previous, "/work", "true", []).args.slice(0, 3)).toEqual([
            `--target=${String(f.child.pid)}`, "--user", "--mount",
        ]);
    } finally { forgetNamespaceEntry(previous); }
});

test("a failed setup ends only its injected setup group and closes inherited streams", async () => {
    const f = fixture();
    await expect(startMountAnchor(plan, seams(() => {
        queueMicrotask(() => { f.child.emit("error", new Error("setup blocked")); });
        return f.child;
    }))).rejects.toThrow("setup blocked");
    expect(f.calls).toEqual(["stop-setup-group"]);
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true);
    f.exit();
    expect(f.calls).toEqual(["stop-setup-group"]);
});

test.each(["exit", "error"] as const)("cleanup signal refusal is reported without escaping an early %s listener", async (event) => {
    const f = fixture();
    const refused = Object.assign(new Error("owned setup group signal refused"), { code: "EPERM" });
    const warnings: Error[] = [];
    f.child.stopSetup = () => { f.calls.push("stop-setup-group"); throw refused; };
    const starting = startMountAnchor(plan, seams(() => f.child, { warn: (error) => { warnings.push(error); } }));
    // The holder starts once its disk is ready, a turn of the loop after the call.
    await Promise.resolve();
    await Promise.resolve();
    expect(() => {
        if (event === "exit") { f.exit(); } else { f.child.emit("error", new Error("setup error")); }
    }).not.toThrow();
    await expect(starting).rejects.toThrow(event === "exit" ? "namespace setup exited" : "setup error");
    expect(warnings).toEqual([refused]);
    expect(f.calls).toEqual(["stop-setup-group"]);
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true);
    f.exit();
    expect(warnings).toEqual([refused]);
});

test("a missing marker's actual deadline reclaims the owned setup group, its streams and its mount table", async () => {
    const f = fixture();
    released.length = 0;
    await expect(startMountAnchor(plan, seams(() => f.child, { readiness: { quietMs: 40, tickMs: 5, describe: () => undefined } }))).rejects.toThrow("namespace setup stalled");
    expect(released).toEqual([FSTAB]);
    expect(f.calls).toEqual(["stop-setup-group"]);
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true);
    f.exit();
    expect(f.calls).toEqual(["stop-setup-group"]);
});

test("no caller can send a fenced plan through the mount-only factory", async () => {
    let starts = 0;
    await expect(startMountAnchor({ ...plan, fence: { folders: ["project"], hidden: [], sessions: "/history/sessions/abc", gitPointers: [""] } }, seams(() => {
        starts += 1;
        return fixture().child;
    }))).rejects.toThrow("requires its sandbox");
    expect(starts).toBe(0);
});
