import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Config as OpenCodeConfig, OpencodeClient } from "@opencode-ai/sdk";
import { requires } from "@intentic/testing/requires";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { createOpenCodeService, processAlive, type OpenCodeGeminiConfig } from "./opencode.js";

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

const linuxPid = requires(process.platform === "linux", "Linux /proc for the service-owned server PID");
const OLD_MODEL = { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] as const };
const NEW_MODEL = { id: "claude-opus-5-5-high", inputModalities: ["text", "image"] as const };
const NEW_SELECTION = { providerID: OPENCODE_GEMINI_PROVIDER, modelID: NEW_MODEL.id };

const killOwned = async (child: ReturnType<typeof spawnChild>): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    child.kill("SIGKILL");
    await exited.promise;
};

// The SDK's close() signals but does not await exit. The first owned child stays alive until the test ends it, so a
// replacement must neither spawn onto its port nor let a raw client probe boot a different catalog in the meantime.
const delayedGoogleRuntime = () => {
    const children: ReturnType<typeof spawnChild>[] = [];
    const configs: (OpenCodeConfig | undefined)[] = [];
    const closing = Promise.withResolvers<void>();
    const models = jest.fn<OpenCodeGeminiConfig["models"]>().mockResolvedValue([OLD_MODEL]);
    let onClosing: (() => void) | undefined;
    const service = createOpenCodeService(XDG, {
        gemini: { baseUrl: "http://127.0.0.1:8789", token: "test", models },
        spawnServer: async (options) => {
            if (children.length > 0) {
                expect(processAlive(children[0]?.pid ?? 0)).toBe(false);
            }
            const index = children.length;
            configs.push(options?.config);
            const child = spawnChild("sleep", ["60"], { stdio: "ignore" });
            children.push(child);
            runningSleep(child.pid ?? 0);
            return {
                url: "http://127.0.0.1:0",
                close: () => {
                    if (index === 0) {
                        onClosing?.();
                        closing.resolve();
                    } else {
                        child.kill("SIGTERM");
                    }
                },
            };
        },
    });
    const firstChild = (): ReturnType<typeof spawnChild> => {
        const child = children[0];
        if (child === undefined) {
            throw new Error("the service did not spawn its first owned child");
        }
        return child;
    };
    return {
        service,
        models,
        configs,
        closing,
        firstChild,
        onClose: (callback: () => void): void => {
            onClosing = callback;
        },
        cleanup: async (): Promise<void> => {
            await Promise.all(children.map(killOwned));
            await service.stop();
        },
    };
};

test.skipIf(!linuxPid.runs)(
    linuxPid.title("catalog replacement waits for its owned process to exit and raw probes share its exact snapshot"),
    async () => {
        const fake = delayedGoogleRuntime();
        try {
            const previous = await fake.service.client();
            fake.models.mockClear();
            // Another discovery would still return the old rows: every caller must share this replacement's exact read.
            fake.models.mockResolvedValueOnce([OLD_MODEL, NEW_MODEL]);
            const probe = Promise.withResolvers<OpencodeClient>();
            fake.onClose(() => probe.resolve(fake.service.client()));
            const acquiring = fake.service.acquire(NEW_SELECTION);
            await fake.closing.promise;
            expect(processAlive(fake.firstChild().pid ?? 0)).toBe(true);
            expect(fake.configs).toHaveLength(1);
            await killOwned(fake.firstChild());
            const lease = await acquiring;
            expect(await probe.promise).toBe(lease.client);
            expect(lease.client).not.toBe(previous);
            expect(fake.configs).toHaveLength(2);
            expect(fake.models).toHaveBeenCalledTimes(1);
            expect(fake.configs.at(-1)?.provider?.[OPENCODE_GEMINI_PROVIDER]?.models).toEqual({
                [OLD_MODEL.id]: { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
                [NEW_MODEL.id]: { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
            });
            lease.release();
        } finally {
            await fake.cleanup();
        }
    },
);

test.skipIf(!linuxPid.runs)(linuxPid.title("a timed-out shutdown stays retryable without spawning onto the still-running process"), async () => {
    const fake = delayedGoogleRuntime();
    let restoreClock: (() => void) | undefined;
    try {
        await fake.service.client();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        // Move the deadline clock, not the child or timer: the shutdown bound is tested without ten seconds of waiting.
        let now = Date.now();
        const clock = jest.spyOn(Date, "now").mockImplementation(() => {
            now += 10_001;
            return now;
        });
        restoreClock = () => clock.mockRestore();
        const failure = "OpenCode's previous runtime has not finished stopping. Retry once it exits.";
        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(failure);
        await expect(fake.service.client()).rejects.toThrow(failure);
        expect(processAlive(fake.firstChild().pid ?? 0)).toBe(true);
        expect(fake.configs).toHaveLength(1);
        restoreClock();
        restoreClock = undefined;
        await killOwned(fake.firstChild());
        const retry = await fake.service.acquire(NEW_SELECTION);
        expect(fake.configs).toHaveLength(2);
        expect(fake.configs.at(-1)?.provider?.[OPENCODE_GEMINI_PROVIDER]?.models).toHaveProperty(NEW_MODEL.id);
        retry.release();
    } finally {
        restoreClock?.();
        await fake.cleanup();
    }
});
