import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import { createOpenCodeService, processAlive } from "./opencode.js";

// The service's data root: never created, since the spawn is a fake and the catalog file boot looks for is absent.
const XDG = "/nonexistent/opencode-env/xdg";

const server = { url: "http://127.0.0.1:0", close: (): void => {} };

// Node's spawn, which the daemon runs on, returns once the child is running its program, so the stamp search right
// after it sees the child's own environment. Bun's can return a moment before that, while /proc still shows the
// environment of the process it was forked from and so no stamp. Holding the stand-in's spawn until `sleep` runs gives
// it Node's guarantee; synchronously, since the search follows the spawn call with no await between.
const runningSleep = (pid: number): void => {
    const deadline = Date.now() + 5_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        try {
            if (readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")[0] === "sleep") {
                return;
            }
        } catch {
            // allow(silent-catch): not listed yet, so asked again after the pause
        }
        Atomics.wait(pause, 0, 0, 1);
    }
};

// The OOM killer took `opencode serve` and the daemon kept handing out its client, so every Gemini turn after failed on
// a bare "fetch failed" until a restart. A real child stands in for the server, found by its spawn stamp as the real one is.
test.if(process.platform === "linux")("a server that died under a booted client is booted afresh by the next call", async () => {
    const children: ReturnType<typeof spawnChild>[] = [];
    let spawns = 0;
    const service = createOpenCodeService(XDG, {
        spawnServer: async () => {
            spawns += 1;
            // Spawned inside the pinned call, so it carries the stamp the service looks for.
            const child = spawnChild("sleep", ["60"], { stdio: "ignore" });
            children.push(child);
            runningSleep(child.pid ?? 0);
            return server;
        },
    });
    try {
        await service.client();
        await service.client();
        expect(spawns).toBe(1);

        const first = children[0];
        const exited = new Promise((resolve) => first?.once("exit", resolve));
        first?.kill("SIGKILL");
        await exited;
        expect(processAlive(first?.pid ?? 0)).toBe(false);

        await service.client();
        expect(spawns).toBe(2);
    } finally {
        for (const child of children) {
            child.kill("SIGKILL");
        }
    }
});
