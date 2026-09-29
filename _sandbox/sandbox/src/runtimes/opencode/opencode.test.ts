import { spawn as spawnChild } from "node:child_process";
import { SPAWN_STAMP_ENV } from "../../workload/workload-class.js";
import { createOpenCodeService, pinnedAcross, processAlive } from "./opencode.js";

// The service's data root: never created, since the spawn is a fake and the catalog file boot looks for is absent.
const XDG = "/nonexistent/opencode-env/xdg";
// What the daemon's own environment holds before a boot, set here so a restore is told apart from a key left unset.
const PRIOR_XDG = "/prior/xdg";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pinned = () => ({
    xdg: process.env["XDG_DATA_HOME"],
    path: process.env["PATH"],
    stamp: process.env[SPAWN_STAMP_ENV],
    share: process.env["OPENCODE_DISABLE_SHARE"],
    projectConfig: process.env["OPENCODE_DISABLE_PROJECT_CONFIG"],
});

const server = { url: "http://127.0.0.1:0", close: (): void => {} };

// A spawn that records the environment it ran under and hands back a server promise the test settles itself.
const heldSpawn = () => {
    const seen: ReturnType<typeof pinned>[] = [];
    let settle: { resolve: (value: typeof server) => void; reject: (error: Error) => void } | undefined;
    let called: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
        called = resolve;
    });
    const spawnServer = () => {
        seen.push(pinned());
        called();
        return new Promise<typeof server>((resolve, reject) => {
            settle = { resolve, reject };
        });
    };
    const release = () => {
        if (settle === undefined) {
            throw new Error("the server was never spawned");
        }
        return settle;
    };
    return { seen, spawned, spawnServer, release };
};

let saved: string | undefined;
beforeEach(() => {
    saved = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = PRIOR_XDG;
});
afterEach(() => {
    if (saved === undefined) {
        delete process.env["XDG_DATA_HOME"];
    } else {
        process.env["XDG_DATA_HOME"] = saved;
    }
});

test("boot pins XDG_DATA_HOME, the spawn stamp and OpenCode's lockdown switches across the spawn call and restores them before the server is up", async () => {
    const before = pinned();
    const spawn = heldSpawn();
    const service = createOpenCodeService(XDG, { spawnServer: spawn.spawnServer });

    const client = service.client();
    await spawn.spawned;

    // Pinned on the spawn rather than left to the image, so a bare dev run ignores a repo's opencode.json too.
    expect(spawn.seen).toStrictEqual([{ xdg: XDG, path: expect.any(String), stamp: expect.stringMatching(UUID), share: "1", projectConfig: "1" }]);
    // The server has not printed its listening line yet: a child spawned now must see the daemon's own environment.
    const restored = { xdg: PRIOR_XDG, path: before.path, stamp: undefined, share: before.share, projectConfig: before.projectConfig };
    expect(pinned()).toStrictEqual(restored);

    spawn.release().resolve(server);
    await client;
    expect(pinned()).toStrictEqual(restored);
});

test("a boot that times out leaves the environment as it found it, and the next call boots again", async () => {
    const before = pinned();
    const first = heldSpawn();
    let spawnServer = first.spawnServer;
    const service = createOpenCodeService(XDG, { spawnServer: () => spawnServer() });

    const failed = service.client();
    await first.spawned;
    first.release().reject(new Error("Timeout waiting for server to start after 60000ms"));

    await expect(failed).rejects.toThrow("Timeout waiting for server to start after 60000ms");
    expect(pinned()).toStrictEqual({ xdg: PRIOR_XDG, path: before.path, stamp: undefined, share: before.share, projectConfig: before.projectConfig });

    const second = heldSpawn();
    spawnServer = second.spawnServer;
    const retried = service.client();
    await second.spawned;
    second.release().resolve(server);
    await retried;
    expect(second.seen.map(({ xdg }) => xdg)).toStrictEqual([XDG]);
});

test("pinnedAcross restores every key once the call returns, deleting the ones that were unset", () => {
    delete process.env["INTENTIC_PIN_UNSET"];
    const during = pinnedAcross({ XDG_DATA_HOME: XDG, INTENTIC_PIN_UNSET: "set" }, () => ({
        xdg: process.env["XDG_DATA_HOME"],
        unset: process.env["INTENTIC_PIN_UNSET"],
    }));

    expect(during).toStrictEqual({ xdg: XDG, unset: "set" });
    expect(process.env["XDG_DATA_HOME"]).toBe(PRIOR_XDG);
    expect("INTENTIC_PIN_UNSET" in process.env).toBe(false);
});

test("pinnedAcross leaves a key given as undefined as it is, during the call and after", () => {
    const during = pinnedAcross({ XDG_DATA_HOME: undefined }, () => process.env["XDG_DATA_HOME"]);

    expect(during).toBe(PRIOR_XDG);
    expect(process.env["XDG_DATA_HOME"]).toBe(PRIOR_XDG);
});

test("pinnedAcross restores the environment when the spawn throws", () => {
    expect(() =>
        pinnedAcross({ XDG_DATA_HOME: XDG }, () => {
            throw new Error("spawn opencode ENOENT");
        }),
    ).toThrow("spawn opencode ENOENT");
    expect(process.env["XDG_DATA_HOME"]).toBe(PRIOR_XDG);
});

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
