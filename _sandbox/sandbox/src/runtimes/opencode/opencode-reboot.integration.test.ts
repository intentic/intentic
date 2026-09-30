import { spawn as spawnChild } from "node:child_process";
import { createOpenCodeService, processAlive } from "./opencode.js";

// The service's data root: never created, since the spawn is a fake and the catalog file boot looks for is absent.
const XDG = "/nonexistent/opencode-env/xdg";

const server = { url: "http://127.0.0.1:0", close: (): void => {} };

// The OOM killer took `opencode serve` and the daemon kept handing out its client, so every Gemini turn after failed on
// a bare "fetch failed" until a restart. A real child stands in for the server, found by its spawn stamp as the real one is.
test.if(process.platform === "linux")("a server that died under a booted client is booted afresh by the next call", async () => {
    const children: ReturnType<typeof spawnChild>[] = [];
    let spawns = 0;
    const service = createOpenCodeService(XDG, {
        spawnServer: async () => {
            spawns += 1;
            // Spawned inside the pinned call, so it carries the stamp the service looks for.
            children.push(spawnChild("sleep", ["60"], { stdio: "ignore" }));
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
