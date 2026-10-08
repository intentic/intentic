import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTimersByTimeAsync, SETTLES, waitFor } from "@intentic/testing/bun";
import { requires } from "@intentic/testing/requires";
import { SPAWN_STAMP_ENV } from "../../workload/workload-class.js";
import { processAlive, type ServedServer, spawnOpencodeServe, waitForExit } from "./opencode-serve.js";

// `spawnOpencodeServe` against a stand-in `opencode`: a shell script in a temp dir that records what it was started with,
// says what the real one says (or fails as the real one can), then sleeps under the same pid until it is ended.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What 2.0.26 prints once it accepts connections.
const LISTENING = "server listening on http://127.0.0.1:41235";

const linuxProc = requires(process.platform === "linux", "Linux /proc, where the grace kill reads a process's spawn stamp");

let dir = "";
const started: ServedServer[] = [];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-serve-"));
});

afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(
        started.splice(0).map(async (served) => {
            const exited = new Promise<void>((resolve) => served.onExit(() => resolve()));
            if (served.process !== undefined && processAlive(served.process.pid)) {
                process.kill(served.process.pid, "SIGKILL");
            }
            await exited;
        }),
    );
    await rm(dir, { recursive: true, force: true });
});

// The stand-in `opencode`: records its pid, arguments and the environment the spawn is meant to hand it, then runs `body`.
const standIn = async (body: string): Promise<string> => {
    const binary = join(dir, "opencode");
    const record = (name: string, value: string): string => `printf '%s' "${value}" > '${join(dir, name)}'`;
    const script = [
        "#!/bin/sh",
        record("pid", "$$"),
        record("args", "$*"),
        record("password", "$OPENCODE_SERVER_PASSWORD"),
        record("stamp", `$${SPAWN_STAMP_ENV}`),
        record("xdg", "$XDG_DATA_HOME"),
        body,
        "",
    ].join("\n");
    await writeFile(binary, script, { mode: 0o755 });
    return binary;
};

const recorded = (name: string): Promise<string> => readFile(join(dir, name), "utf8");

// Starts the stand-in; a server that came up is ended after the test.
const serve = async (binary: string, options: { readonly port?: number; readonly env?: Record<string, string>; readonly timeoutMs?: number } = {}) => {
    const served = await spawnOpencodeServe({ binary, port: options.port ?? 0, env: options.env ?? {}, timeoutMs: options.timeoutMs ?? 30_000 });
    started.push(served);
    return served;
};

// Whether a promise has settled yet, read without awaiting it.
const tracked = <T>(promise: Promise<T>): (() => boolean) => {
    let settled = false;
    promise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    return () => settled;
};

const exitOf = (served: ServedServer): Promise<string> => new Promise((resolve) => served.onExit(resolve));

test("a server that prints its address is handed back with it, a per-boot basic credential, and its pid and stamp", async () => {
    const binary = await standIn(`echo '${LISTENING}'\nexec sleep 60`);

    const served = await serve(binary, { env: { XDG_DATA_HOME: "/data/xdg" } });

    expect(served.url).toBe("http://127.0.0.1:41235");
    const password = await recorded("password");
    // 24 random bytes, base64url: nothing a header or a shell would need escaped.
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(served.headers).toEqual({ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` });
    const stamp = await recorded("stamp");
    expect(stamp).toMatch(UUID);
    expect(served.process).toEqual({ pid: Number(await recorded("pid")), stamp });
    expect(await recorded("args")).toBe("serve --hostname 127.0.0.1 --port 0");
    expect(await recorded("xdg")).toBe("/data/xdg");
    // Handed to the child alone: the daemon's own environment never holds the password or the stamp.
    expect(Object.keys(process.env).filter((key) => key === "OPENCODE_SERVER_PASSWORD" || key === SPAWN_STAMP_ENV)).toEqual([]);
});

test("every boot mints its own password and stamp, and asks for the port it is given", async () => {
    const binary = await standIn(`echo '${LISTENING}'\nexec sleep 60`);
    const first = await serve(binary);
    const firstPassword = await recorded("password");

    const second = await serve(binary, { port: 4096 });

    expect(await recorded("args")).toBe("serve --hostname 127.0.0.1 --port 4096");
    const secondPassword = await recorded("password");
    expect([secondPassword === firstPassword, second.process?.stamp === first.process?.stamp]).toEqual([false, false]);
    expect(second.headers).toEqual({ authorization: `Basic ${Buffer.from(`opencode:${secondPassword}`).toString("base64")}` });
});

test("the address counts on stderr too, after whatever the server said first", async () => {
    const binary = await standIn("echo 'Warning: a plugin is slow to load' >&2\necho 'opencode server listening on http://127.0.0.1:41236' >&2\nexec sleep 60");

    const served = await serve(binary);

    expect(served.url).toBe("http://127.0.0.1:41236");
});

// A line that reaches the pipe in two reads once resolved with the address cut short. 2.0.26 writes the line in one
// write, under PIPE_BUF, which is why boots worked.
test("an address split across two writes is read whole", async () => {
    const binary = await standIn("printf 'server listening on http://127.0.0.1:41'\nsleep 0.2\nprintf '237\\n'\nexec sleep 60");

    const served = await serve(binary);

    expect(served.url).toBe("http://127.0.0.1:41237");
});

// The stand-ins below exit straight after writing: the exit event can come before the last of the output is read, and a
// boot that rejected on it once lost the tail about 1 run in 40.
test("a server that exits before it is ready rejects with its exit and the tail of what it said", async () => {
    const binary = await standIn("echo 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4096' >&2\nexit 3");

    await expect(serve(binary)).rejects.toThrow(
        new Error("OpenCode exited before it was ready (code 3). It said: Error: listen EADDRINUSE: address already in use 127.0.0.1:4096"),
    );
});

test("the tail a failed boot quotes is the last thousand characters", async () => {
    const said = `${"a".repeat(500)}${"b".repeat(1_000)}`;
    const binary = await standIn(`printf '%s' '${said}'\nexit 1`);

    await expect(serve(binary)).rejects.toThrow(new Error(`OpenCode exited before it was ready (code 1). It said: ${"b".repeat(1_000)}`));
});

test.each([
    ["says nothing", "exec sleep 60", "OpenCode did not start within 1s."],
    ["never says where it listens", "echo 'Performing one time database migration...'\nexec sleep 60", "OpenCode did not start within 1s. It said: Performing one time database migration..."],
])("a server that %s past its timeout is killed and the boot rejects", async (_case, body, sentence) => {
    const binary = await standIn(body);

    await expect(serve(binary, { timeoutMs: 1_000 })).rejects.toThrow(new Error(sentence));

    const pid = Number(await recorded("pid"));
    // Killed outright, so gone as soon as the runtime has reaped it.
    await waitFor(() => expect(processAlive(pid)).toBe(false), SETTLES);
});

test("a binary that cannot be started rejects saying why", async () => {
    await expect(serve(join(dir, "no-such-opencode"))).rejects.toThrow(/^OpenCode could not be started: .*ENOENT/);
});

test("onExit hears the exit and its cause, and a listener that comes after it hears at once", async () => {
    const binary = await standIn(`echo '${LISTENING}'\nexec sleep 60`);
    const served = await serve(binary);
    const first = exitOf(served);

    process.kill(served.process?.pid ?? 0, "SIGKILL");

    const summary = `OpenCode's server exited (SIGKILL). It said: ${LISTENING}`;
    expect(await first).toBe(summary);
    const late: string[] = [];
    served.onExit((said) => void late.push(said));
    expect(late).toEqual([summary]);
});

test("close sends SIGTERM, and waitForExit returns once the server is gone", async () => {
    const binary = await standIn(`echo '${LISTENING}'\nexec sleep 60`);
    const served = await serve(binary);
    const exited = exitOf(served);

    served.close();
    await waitForExit(served.process ?? { pid: 0, stamp: "" }, processAlive);

    expect(await exited).toBe(`OpenCode's server exited (SIGTERM). It said: ${LISTENING}`);
    expect(processAlive(served.process?.pid ?? 0)).toBe(false);
});

// On CI the real server ran the SIGTERM handlers it had installed and stayed up; the stand-in ignores SIGTERM outright.
test.skipIf(!linuxProc.runs)(linuxProc.title("waitForExit kills a server that outlives SIGTERM once the three-second grace is over"), async () => {
    const binary = await standIn(`trap '' TERM\necho '${LISTENING}'\nexec sleep 60`);
    const served = await serve(binary);
    const exited = exitOf(served);
    const pid = served.process?.pid ?? 0;
    jest.useFakeTimers();

    served.close();
    const waiting = waitForExit(served.process ?? { pid: 0, stamp: "" }, processAlive);
    await advanceTimersByTimeAsync(2_999);
    expect(processAlive(pid)).toBe(true);
    await advanceTimersByTimeAsync(1);

    expect(await exited).toBe(`OpenCode's server exited (SIGKILL). It said: ${LISTENING}`);
    // The wait looks again on its next poll and finds it gone.
    await advanceTimersByTimeAsync(20);
    await waiting;
});

// A pid the kernel has handed to something else no longer carries this boot's stamp, and must not be killed for it.
test.skipIf(!linuxProc.runs)(
    linuxProc.title("waitForExit never kills a process without the boot's stamp, and gives up after ten seconds"),
    async () => {
        const binary = await standIn(`trap '' TERM\necho '${LISTENING}'\nexec sleep 60`);
        const served = await serve(binary);
        const pid = served.process?.pid ?? 0;
        jest.useFakeTimers();

        const waiting = waitForExit({ pid, stamp: "a-stamp-this-process-never-carried" }, processAlive);
        const settled = tracked(waiting);
        await advanceTimersByTimeAsync(9_999);
        expect([settled(), processAlive(pid)]).toEqual([false, true]);
        await advanceTimersByTimeAsync(1);

        await expect(waiting).rejects.toThrow(new Error("OpenCode's previous runtime has not finished stopping. Retry once it exits."));
        expect(processAlive(pid)).toBe(true);
    },
);

test("processAlive reads a running process as alive, one that may not be signalled too, and an ended one as gone", async () => {
    const binary = await standIn("exit 0");
    await expect(serve(binary)).rejects.toThrow(new Error("OpenCode exited before it was ready (code 0)."));
    const ended = Number(await recorded("pid"));

    // pid 1 is init: signalling it is refused (EPERM) unless this runs as root, and either way it is there.
    expect([processAlive(process.pid), processAlive(1), processAlive(ended)]).toEqual([true, true, false]);
});
