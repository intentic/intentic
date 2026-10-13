import { EventEmitter } from "node:events";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { PassThrough } from "node:stream";
import { NamespaceSetupError, namespaceHolderLifetime, namespaceHolderReady, withSetupRetry } from "./namespace-holder.js";
import { forgetNamespaceEntry, nsenterArgv, registerMountEntry, registerSandboxEntry } from "./namespace-entry.js";

let nextPid = 61_000;
const holder = () => Object.assign(new EventEmitter(), {
    pid: nextPid++, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(), stderr: new PassThrough(),
});
const exited = (child: ReturnType<typeof holder>): void => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
};

test("a holder owns exactly its issued entry, retiring it once when it actually exits", async () => {
    const child = holder();
    const cleanups: string[] = [];
    const lifetime = namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    const readiness = namespaceHolderReady(child, "ready");
    child.stdout.write("ready\n");
    const pid = await readiness;
    const reference = lifetime.register(() => registerMountEntry(pid));
    expect(reference.pid).toBe(child.pid);
    expect(nsenterArgv(reference, "/work", "true", [])).toEqual({ command: "nsenter", args: [
        `--mount=/proc/${String(child.pid)}/ns/mnt`, "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "true",
    ] });
    expect(() => lifetime.register(() => registerMountEntry(nextPid++))).toThrow("already has an entry");
    exited(child);
    lifetime.end();
    expect(cleanups).toEqual(["end"]);
    expect(() => nsenterArgv(reference, "/work", "true", [])).toThrow("reference is not registered");
});

test("loss after the ready marker but before registration cannot return a live entry", async () => {
    const child = holder();
    const cleanups: string[] = [];
    const lifetime = namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    const readiness = namespaceHolderReady(child, "ready");
    child.stdout.write("ready\n");
    exited(child);
    await expect(readiness).resolves.toBe(child.pid);
    let issues = 0;
    expect(() => lifetime.register(() => { issues += 1; return registerMountEntry(child.pid); })).toThrow("ended during setup");
    expect(issues).toBe(0);
    expect(cleanups).toEqual(["end"]);
});

test("a registration collision ends only the new holder and leaves the previous generation usable", async () => {
    const child = holder();
    const previous = registerSandboxEntry(child.pid, { uid: 1000, gid: 1000 });
    const cleanups: string[] = [];
    const lifetime = namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    try {
        expect(() => lifetime.register(() => registerMountEntry(child.pid))).toThrow("already registered");
        lifetime.end();
        exited(child);
        expect(cleanups).toEqual(["end"]);
        expect(nsenterArgv(previous, "/work", "true", []).args.slice(0, 3)).toEqual([
            `--target=${String(child.pid)}`, "--user", "--mount",
        ]);
    } finally { forgetNamespaceEntry(previous); }
});

test("an old holder's later exit cannot retire a replacement registration with the same PID", () => {
    const child = holder();
    const cleanups: string[] = [];
    const lifetime = namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    const old = lifetime.register(() => registerMountEntry(child.pid));
    lifetime.end();
    const fresh = registerMountEntry(child.pid);
    try {
        exited(child);
        expect(cleanups).toEqual(["end"]);
        expect(() => nsenterArgv(old, "/work", "true", [])).toThrow("reference is not registered");
        expect(nsenterArgv(fresh, "/work", "true", []).args[0]).toBe(`--mount=/proc/${String(child.pid)}/ns/mnt`);
    } finally { forgetNamespaceEntry(fresh); }
});

test("fenced readiness needs both a whole marker line and a delimited, whole reported PID", async () => {
    const child = holder();
    const info = new PassThrough();
    const readiness = namespaceHolderReady(child, "sandbox-ready", info);
    let settled = false;
    void readiness.then(() => { settled = true; });
    child.stdout.write("not-sandbox-ready\nsandbox-ready");
    info.write('{ "child-pid": 61');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write("\n");
    await Promise.resolve();
    expect(settled).toBe(false);
    info.write('234 }\n');
    await expect(readiness).resolves.toBe(61_234);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(info.listenerCount("data")).toBe(0);
});

test("a holder error rejects setup with stderr captured and leaves no readiness listeners", async () => {
    const child = holder();
    const cleanups: string[] = [];
    namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    const readiness = namespaceHolderReady(child, "ready");
    child.stderr.write("mount refused");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(readiness).rejects.toThrow("namespace setup exited 1: mount refused");
    expect(cleanups).toEqual(["end"]);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    child.emit("error", new Error("late spawn error"));
    expect(cleanups).toEqual(["end"]);
});

test("invalid inner PIDs refuse fenced setup instead of minting an entrant", async () => {
    for (const pid of ["0", "9007199254740992"]) {
        const child = holder();
        const info = new PassThrough();
        const readiness = namespaceHolderReady(child, "ready", info);
        child.stdout.write("ready\n");
        info.write(`{ "child-pid": ${pid} }\n`);
        await expect(readiness).rejects.toThrow("reported an invalid PID");
    }
});

test("an already ended holder or missing fenced info stream refuses without awaiting a handshake", async () => {
    const child = holder();
    child.signalCode = "SIGKILL";
    await expect(namespaceHolderReady(child, "ready")).rejects.toThrow("not live with readiness streams");
    await expect(namespaceHolderReady(holder(), "ready", null)).rejects.toThrow("not live with readiness streams");
});

test("loss during registration still retires the issued entry, even when its issue callback triggers exit", () => {
    const child = holder();
    const cleanups: string[] = [];
    const lifetime = namespaceHolderLifetime(child, () => { cleanups.push("end"); });
    let issued: ReturnType<typeof registerMountEntry> | undefined;
    expect(() => lifetime.register(() => {
        issued = registerMountEntry(child.pid);
        exited(child);
        return issued;
    })).toThrow("ended during setup");
    expect(cleanups).toEqual(["end"]);
    expect(() => nsenterArgv(issued!, "/work", "true", [])).toThrow("reference is not registered");
    const fresh = registerMountEntry(child.pid);
    forgetNamespaceEntry(fresh);
});

test.each(["ready", "isolation-ready", "sandbox-ready"])("a complete %s marker is parsed before a long chunk's suffix is bounded", async (marker) => {
    const child = holder();
    const readiness = namespaceHolderReady(child, marker);
    child.stdout.write(`${marker}\n${"x".repeat(8192)}`);
    await expect(readiness).resolves.toBe(child.pid);
});

test.each(["ready", "isolation-ready", "sandbox-ready"])("bounding output cannot turn not-%s into a readiness line", async (marker) => {
    const child = holder();
    const readiness = namespaceHolderReady(child, marker);
    let settled = false;
    void readiness.then(() => { settled = true; });
    // An 8192-byte suffix of this chunk starts at the marker inside the wrong, longer line.
    child.stdout.write(`not-${marker}\n${"x".repeat(8192 - marker.length - 1)}`);
    await Promise.resolve();
    expect(settled).toBe(false);
    // Discard the open oversized line before admitting the next actual whole marker line.
    child.stdout.write(`\n${marker.slice(0, 2)}`);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write(`${marker.slice(2)}\n`);
    await expect(readiness).resolves.toBe(child.pid);
});

test("discarding a long incomplete line cannot admit its marker-looking suffix in a later chunk", async () => {
    const child = holder();
    const readiness = namespaceHolderReady(child, "ready");
    let settled = false;
    void readiness.then(() => { settled = true; });
    child.stdout.write("x".repeat(8192));
    child.stdout.write("ready\n");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write("ready\n");
    await expect(readiness).resolves.toBe(child.pid);
});

test("a complete fenced PID report survives later noise in the same info chunk", async () => {
    const child = holder();
    const info = new PassThrough();
    const readiness = namespaceHolderReady(child, "ready", info);
    child.stdout.write("ready\n");
    info.write(`{"child-pid":61234}\n${"x".repeat(8192)}`);
    await expect(readiness).resolves.toBe(61_234);
});

// The setup failure a readiness promise ends in; anything else fails the test.
const setupFailure = async (readiness: Promise<number>): Promise<NamespaceSetupError> => {
    const failure = await readiness.then(() => undefined, (error: unknown) => error);
    if (!(failure instanceof NamespaceSetupError)) { throw new Error(`expected a setup failure, got ${String(failure)}`); }
    return failure;
};

// A clock the test moves: real time plus whatever freeze it stands in for.
const frozenClock = () => {
    let offset = 0;
    return { now: () => Date.now() + offset, freeze: (ms: number) => { offset += ms; } };
};

test("a freeze of the daemon itself is not counted against the holder: a ready line waiting in the pipe still admits", async () => {
    const child = holder();
    const clock = frozenClock();
    const readiness = namespaceHolderReady(child, "ready", undefined, { quietMs: 200, tickMs: 5, now: clock.now, describe: () => undefined });
    // 2026-10-13: the daemon froze 12 s while a holder started; its deadline passed inside the freeze.
    clock.freeze(12_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdout.write("ready\n");
    await expect(readiness).resolves.toBe(child.pid);
});

test("a holder that says nothing stalls, and the failure names how far it got and what it was doing", async () => {
    const child = holder();
    const readiness = namespaceHolderReady(child, "ready", undefined, { quietMs: 60, tickMs: 5, describe: () => "was running mount -a (state D, waiting in ovl_fill_super)" });
    child.stdout.write(`${WORKSPACE_ROOT}/node_modules: successfully mounted\n`);
    const setup = await setupFailure(readiness);
    expect(setup.failure).toBe("stalled");
    expect(setup.transient).toBe(true);
    expect(setup.facts.steps).toBe(1);
    expect(setup.message).toMatch(/^namespace setup stalled: no progress for /u);
    expect(setup.message).toContain(`1 mount done, the last ${WORKSPACE_ROOT}/node_modules: successfully mounted`);
    expect(setup.message).toContain("waiting in ovl_fill_super");
    expect(child.stdout.listenerCount("data")).toBe(0);
});

test("steady progress keeps a slow setup alive past the quiet bound, up to the cap", async () => {
    const child = holder();
    const readiness = namespaceHolderReady(child, "ready", undefined, { quietMs: 40, capMs: 5_000, tickMs: 5, describe: () => undefined });
    for (let mount = 0; mount < 6; mount += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        child.stdout.write(`${WORKSPACE_ROOT}/m${String(mount)}: successfully mounted\n`);
    }
    child.stdout.write("ready\n");
    await expect(readiness).resolves.toBe(child.pid);
});

test("a holder that keeps reporting but never finishes is stopped at the cap", async () => {
    const child = holder();
    const readiness = namespaceHolderReady(child, "ready", undefined, { quietMs: 1_000, capMs: 60, tickMs: 5, describe: () => undefined });
    const chatter = setInterval(() => { child.stdout.write(`${WORKSPACE_ROOT}/x: successfully mounted\n`); }, 5);
    try {
        await expect(readiness).rejects.toThrow("namespace setup did not finish within");
    } finally { clearInterval(chatter); }
});

test("an exit with nothing on stderr says so without a dangling colon", async () => {
    const child = holder();
    const readiness = namespaceHolderReady(child, "ready", undefined, { describe: () => undefined });
    child.exitCode = 32;
    child.emit("exit", 32, null);
    const failure = await setupFailure(readiness);
    expect(failure.message).toBe("namespace setup exited 32 (no mount reported done)");
    expect(failure.transient).toBe(false);
});

test("setup is tried once more only when the holder did not answer in time", async () => {
    const stalled = new NamespaceSetupError("stalled", "namespace setup stalled", { steps: 0, awakeMs: 10_000, frozenMs: 0 });
    let starts = 0;
    const retried: NamespaceSetupError[] = [];
    await expect(withSetupRetry(async () => {
        starts += 1;
        if (starts === 1) { throw stalled; }
        return "anchor";
    }, { delayMs: 1, onRetry: (error) => { retried.push(error); } })).resolves.toBe("anchor");
    expect(starts).toBe(2);
    expect(retried).toEqual([stalled]);

    // A holder that answered with a failure would answer the same again.
    let exits = 0;
    await expect(withSetupRetry(async () => {
        exits += 1;
        throw new NamespaceSetupError("exited", "namespace setup exited 32", { steps: 0, awakeMs: 5, frozenMs: 0 });
    }, { delayMs: 1 })).rejects.toThrow("exited 32");
    expect(exits).toBe(1);

    // A second stall is the caller's to report: no third attempt.
    let stalls = 0;
    await expect(withSetupRetry(async () => { stalls += 1; throw stalled; }, { delayMs: 1 })).rejects.toBe(stalled);
    expect(stalls).toBe(2);
});
