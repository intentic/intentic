import { waitFor } from "@intentic/testing/bun";
import { commonProtocol, type ControlConnection, type ControlMessage, type ControlRequest, REMOTED_CONTROL_PROTOCOL, remotedEndpoint } from "./remoted-control.js";
import type { RemotedStatus } from "./remoted-files.js";
import { createRemotedProcess, type DetachedRemoted, idleStatus, type RemotedChild, type RemotedControlSeams, type RemotedExit, staleBuild } from "./remoted.js";

/* Which remoted the agent holds when it starts: the one already running here, adopted over its control endpoint when
   both speak a protocol, else one started detached; replaced when it speaks none of this agent's, or once idle when an
   upgrade ships another build; and this agent's child where adopting is off or the binary is from before it. Every
   remoted here is a fake connection or a fake process. */

const status = (over: Partial<RemotedStatus> = {}): RemotedStatus => ({
    type: "status",
    version: "1.0.0",
    pid: 4242,
    uplinks: [],
    people: [],
    terminals: 0,
    environments: ["native"],
    monitors: [],
    ...over,
});

// A remoted at the other end of a control connection: what the agent sent it, and a way to speak and to leave.
interface FakeRemoted {
    readonly connection: ControlConnection;
    readonly sent: ControlRequest[];
    readonly say: (message: ControlMessage) => void;
    readonly end: () => void;
}

const fakeRemoted = (hello: { readonly accepts: readonly number[]; readonly build: string; readonly pid: number }): FakeRemoted => {
    const sent: ControlRequest[] = [];
    const listeners: ((message: ControlMessage) => void)[] = [];
    let end = (): void => undefined;
    const closed = new Promise<void>((resolve) => (end = resolve));
    const connection: ControlConnection = {
        hello: { type: "hello", protocol: Math.max(...hello.accepts), accepts: [...hello.accepts], build: hello.build, pid: hello.pid },
        send: (message) => {
            sent.push(message);
            // A remoted asked to stop leaves, which closes the connection.
            if (message.type === "stop") {
                end();
            }
        },
        onMessage: (listener) => void listeners.push(listener),
        closed,
        close: () => end(),
    };
    return { connection, sent, say: (message) => listeners.forEach((listener) => listener(message)), end: () => end() };
};

const harness = (over: { readonly endpoint?: (FakeRemoted | undefined)[]; readonly protocols?: readonly number[] | undefined; readonly build?: string; readonly detachable?: boolean } = {}) => {
    const logged: string[] = [];
    const statuses: (RemotedStatus | undefined)[] = [];
    const detached: string[] = [];
    const children: string[] = [];
    // What the endpoint answers, one connect after another; nothing once the list runs out.
    const answers = [...(over.endpoint ?? [])];
    const control: RemotedControlSeams = {
        endpoint: "/state/remoted.sock",
        connect: async () => await Promise.resolve(answers.shift()?.connection),
        detach: (binary): DetachedRemoted => {
            detached.push(binary);
            return { pid: 777, exited: new Promise<RemotedExit>(() => undefined), kill: () => undefined, lastLine: async () => await Promise.resolve(undefined) };
        },
        protocolsOf: () => ("protocols" in over ? over.protocols : [REMOTED_CONTROL_PROTOCOL]),
        build: over.build ?? "1.0.0",
        detachable: () => over.detachable ?? true,
    };
    let stdinClosed = 0;
    const process = createRemotedProcess({
        spawn: (binary): RemotedChild => {
            children.push(binary);
            let exit = (_: RemotedExit): void => undefined;
            const exited = new Promise<RemotedExit>((resolve) => (exit = resolve));
            return {
                pid: 99,
                exited,
                leave: () => {
                    stdinClosed++;
                    exit({ code: 0, signal: null });
                },
                kill: () => undefined,
                lastLine: () => undefined,
            };
        },
        control,
        configPath: "/state/remoted.json",
        log: (message) => void logged.push(message),
        onStatus: (next) => void statuses.push(next),
        now: Date.now,
    });
    return { process, logged, statuses, detached, children, answers, stdinClosed: () => stdinClosed };
};

const BIN = "/bin/intentic-remoted";

// waitFor retries what throws: a condition that is not yet true throws.
const until = async (condition: () => boolean, timeout = 1_000): Promise<void> =>
    await waitFor(
        () => {
            if (!condition()) {
                throw new Error("not yet");
            }
        },
        { timeout },
    );

describe("adopting the remoted that outlived the agent before", () => {
    test("one speaking a protocol of this agent's is adopted, not started again, and let go running when the agent leaves", async () => {
        const running = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 31 });
        const { process, statuses, detached, children, logged } = harness({ endpoint: [running] });
        process.ensure(BIN);
        await until(() => running.sent.length > 0);
        expect(running.sent).toEqual([{ type: "adopt", protocol: REMOTED_CONTROL_PROTOCOL }]);
        running.say({ ...status({ terminals: 2 }) });
        await until(() => statuses.length > 0);
        expect(process.status()?.terminals).toBe(2);
        running.say({ type: "log", line: "INFO remoted: a line" });
        expect(logged).toContain("remoted: INFO remoted: a line");
        expect([...detached, ...children]).toEqual([]);

        await process.release();
        // Let go, not asked to stop: its terminals carry on for the next agent.
        expect(running.sent.map((message) => message.type)).toEqual(["adopt"]);
        expect(logged.at(-1)).toBe("remoted: left running (pid 31) for the next agent to adopt");
        expect(process.running()).toBe(false);
    });

    test("the highest protocol both speak is the one asked for", () => {
        expect(commonProtocol([1, 2, 3], [2, 3, 4])).toBe(3);
        expect(commonProtocol([5], [1, 2])).toBeUndefined();
        expect(commonProtocol([], [1])).toBeUndefined();
    });

    test("one speaking none of this agent's protocols is asked to leave, and one started detached is adopted", async () => {
        const old = fakeRemoted({ accepts: [99], build: "0.9.0", pid: 31 });
        const fresh = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 777 });
        const { process, detached, logged } = harness({ endpoint: [old, undefined, fresh] });
        process.ensure(BIN);
        await until(() => fresh.sent.length > 0);
        expect(old.sent).toEqual([{ type: "stop" }]);
        expect(detached).toEqual([BIN]);
        expect(fresh.sent).toEqual([{ type: "adopt", protocol: REMOTED_CONTROL_PROTOCOL }]);
        expect(logged.some((line) => line.includes("speaks control protocols 99, none of this agent's: replacing it"))).toBe(true);
        await process.release();
    });

    test("one of another build (an upgrade) is kept while anything is open on it, and replaced once nothing is", async () => {
        const old = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 31 });
        const fresh = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.1.0", pid: 777 });
        const { process, detached } = harness({ endpoint: [old, undefined, fresh], build: "1.1.0" });
        process.ensure(BIN);
        await until(() => old.sent.length > 0);
        old.say({ ...status({ terminals: 1 }) });
        old.say({ ...status({ terminals: 0, people: [{ uplink: "a", kind: "view", session: "s", since: 1 }] }) });
        expect(old.sent.map((message) => message.type)).toEqual(["adopt"]);
        expect(detached).toEqual([]);

        old.say({ ...status({ terminals: 0 }) });
        await until(() => fresh.sent.length > 0);
        expect(old.sent.map((message) => message.type)).toEqual(["adopt", "stop"]);
        expect(detached).toEqual([BIN]);
        await process.release();
    });

    test("a remoted that leaves while adopted is looked for again, and adopted when it is back", async () => {
        const first = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 31 });
        const again = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 31 });
        const { process, statuses, logged } = harness({ endpoint: [first, again] });
        process.ensure(BIN);
        await until(() => first.sent.length > 0);
        first.end();
        await until(() => statuses.includes(undefined));
        expect(logged.some((line) => line.startsWith("remoted: its control connection closed; starting it again in 1s"))).toBe(true);
        await until(() => again.sent.length > 0, 3_000);
        await process.stop();
        expect(again.sent.map((message) => message.type)).toEqual(["adopt", "stop"]);
    });
});

describe("a remoted that is this agent's child", () => {
    test("a binary from before the control protocol runs as the agent's child, stopped when the agent leaves", async () => {
        const { process, children, detached, stdinClosed } = harness({ protocols: undefined });
        process.ensure(BIN);
        await until(() => children.length > 0);
        expect(detached).toEqual([]);
        await process.release();
        expect(stdinClosed()).toBe(1);
    });

    test("before sign-in nothing is adopted or left behind: its remoted has no desktop", async () => {
        const running = fakeRemoted({ accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.0.0", pid: 31 });
        const { process, children, answers } = harness({ endpoint: [running], detachable: false });
        process.ensure(BIN);
        await until(() => children.length > 0);
        expect(answers).toHaveLength(1);
        expect(running.sent).toEqual([]);
        await process.release();
    });
});

describe("pure readings", () => {
    test("idle is no terminal and nobody connected", () => {
        expect(idleStatus(status())).toBe(true);
        expect(idleStatus(status({ terminals: 1 }))).toBe(false);
        expect(idleStatus(status({ people: [{ uplink: "a", kind: "terminal", session: "t", since: 1 }] }))).toBe(false);
    });

    test("another build is stale only where this agent knows its own", () => {
        expect(staleBuild("1.0.0", "1.1.0")).toBe(true);
        expect(staleBuild("1.1.0", "1.1.0")).toBe(false);
        expect(staleBuild("0.0.0", undefined)).toBe(false);
    });

    test("the endpoint is a socket beside the state, a runtime-dir socket when that is too long, a named pipe on Windows", () => {
        expect(remotedEndpoint("/home/me/.intentic/machine", "linux", {})).toBe("/home/me/.intentic/machine/remoted.sock");
        const long = `/home/${"x".repeat(120)}`;
        expect(remotedEndpoint(long, "linux", { XDG_RUNTIME_DIR: "/run/user/1000" })).toMatch(/^\/run\/user\/1000\/intentic-remoted-[0-9a-f]{16}\.sock$/);
        const pipe = remotedEndpoint("C:\\Users\\Me\\.intentic\\machine", "win32", {});
        expect(pipe).toMatch(/^\\\\\.\\pipe\\intentic-remoted-control-[0-9a-f]{16}$/);
        // One environment, one name, however the path is cased on Windows.
        expect(remotedEndpoint("c:\\users\\me\\.intentic\\machine", "win32", {})).toBe(pipe);
    });
});
