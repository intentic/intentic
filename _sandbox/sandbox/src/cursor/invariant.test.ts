import { expect, test } from "vitest";
import type { CursorHookService } from "./cursor-hooks.js";
import { checks } from "./invariant.js";

/* Three links, each a path another daemon can rewrite after this one said `ready`. Each is broken in turn
 * below, and the socket one by the only means that can see it: asking who is listening. */

const fail = (message: string): never => {
    throw new Error(message);
};

const PATHS = {
    socket: "/work/.intentic/secrets/auth/cursor/command-gate.sock",
    script: "/work/.intentic/secrets/auth/cursor/intentic-command-gate.mjs",
    hooks: "/etc/cursor/hooks.json",
};
const PID = 4242;

const hooksNaming = (script: string): string =>
    JSON.stringify({ hooks: { beforeShellExecution: [{ command: `node ${JSON.stringify(script)} gate` }] } });
const scriptNaming = (socket: string): string => `const call = request({ socketPath: ${JSON.stringify(socket)}, path: "/gate" });`;

const run = async (input: { ready?: boolean; files: Readonly<Record<string, string>>; listener: number | undefined }): Promise<void> => {
    const cursorHooks = { ready: () => input.ready ?? true, paths: () => PATHS } as unknown as CursorHookService;
    const [check] = checks({ cursorHooks, readText: async (path) => input.files[path], listenerPid: async () => input.listener, pid: PID });
    await check?.run({ moment: "sweep", fail });
};

const intact = { [PATHS.hooks]: hooksNaming(PATHS.script), [PATHS.script]: scriptNaming(PATHS.socket) };

test("a chain that leads back to this daemon reports nothing", async () => {
    await expect(run({ files: intact, listener: PID })).resolves.toBeUndefined();
});

test("a gate that never started has nothing to check", async () => {
    await expect(run({ ready: false, files: {}, listener: undefined })).resolves.toBeUndefined();
});

test("a hooks file that was never installed is start()'s report, not this one's", async () => {
    await expect(run({ files: { [PATHS.script]: scriptNaming(PATHS.socket) }, listener: PID })).resolves.toBeUndefined();
});

test("a hooks file naming another daemon's script is the hook taken", async () => {
    const files = { ...intact, [PATHS.hooks]: hooksNaming("/elsewhere/intentic-command-gate.mjs") };
    await expect(run({ files, listener: PID })).rejects.toThrow(/another daemon has taken the hook/);
});

test("a script naming another daemon's socket is the second link broken", async () => {
    const files = { ...intact, [PATHS.script]: scriptNaming("/elsewhere/command-gate.sock") };
    await expect(run({ files, listener: PID })).rejects.toThrow(/no longer names this daemon's socket/);
});

test("a socket answered by another process is the link the filesystem cannot show", async () => {
    await expect(run({ files: intact, listener: 99 })).rejects.toThrow(/answered by pid 99, not this daemon \(pid 4242\)/);
});

test("a socket nobody answers on says so", async () => {
    await expect(run({ files: intact, listener: undefined })).rejects.toThrow(/answered by nobody/);
});
