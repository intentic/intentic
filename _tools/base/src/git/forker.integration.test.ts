import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ForkRequest, ForkResponse } from "./forker.js";

// Pins the forker's survival contract against its real child half: a command whose argv is past the OS's ARG_MAX makes
// posix_spawn throw synchronously (spawn E2BIG), which must come back as that one call's failure, never as the
// forker's death — every git the daemon runs shares this one child.

const forkerModule = fileURLToPath(new URL("./forker.ts", import.meta.url));

interface ForkerProbe {
    readonly child: ChildProcess;
    readonly ask: (request: Omit<ForkRequest, "id">) => Promise<ForkResponse>;
    readonly stop: () => void;
}

const startForker = (): ForkerProbe => {
    // Bun runs the TypeScript module straight; execArgv: [] keeps the child a bare forking stub, as the runner forks it.
    const child = fork(forkerModule, { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let nextId = 0;
    const waiting = new Map<number, (response: ForkResponse) => void>();
    child.on("message", (message) => {
        // SAFETY: the child is this repo's forker module, which sends only ForkResponse.
        const response = message as ForkResponse;
        waiting.get(response.id)?.(response);
        waiting.delete(response.id);
    });
    const ask = (request: Omit<ForkRequest, "id">): Promise<ForkResponse> =>
        new Promise<ForkResponse>((resolve) => {
            nextId += 1;
            waiting.set(nextId, resolve);
            child.send({ id: nextId, ...request } satisfies ForkRequest);
        });
    return { child, ask, stop: () => child.kill() };
};

test("an argv past ARG_MAX fails that one call (E2BIG) and the forker answers the next call", async () => {
    const probe = startForker();
    try {
        // ~3 MB of argv over an empty environment: past Linux's 2 MB ARG_MAX, each arg under the 128 KB single-arg
        // cap, shaped like a land's `git diff -- <every path>`.
        const hugeArgs = Array.from({ length: 20_000 }, (_, index) => `generated/very/deep/path/component/file-${String(index).padStart(6, "0")}-${"x".repeat(120)}.json`);
        // Issued together, so the small call is in flight while the big one throws: a crash would take both down.
        const [big, concurrent] = await Promise.all([
            probe.ask({ command: "true", args: hugeArgs, maxBuffer: 1024 * 1024, env: {} }),
            probe.ask({ command: "echo", args: ["still-here"], maxBuffer: 1024 * 1024, env: {} }),
        ]);
        expect(big.failure?.code).toBe("E2BIG");
        expect(concurrent.failure).toBeUndefined();
        expect(concurrent.stdout.trim()).toBe("still-here");
        // And the forker is still answering afterwards, not a fresh child the runner had to restart.
        const after = await probe.ask({ command: "echo", args: ["after"], maxBuffer: 1024 * 1024, env: {} });
        expect(after.stdout.trim()).toBe("after");
        expect(probe.child.exitCode).toBeNull();
    } finally {
        probe.stop();
    }
});
