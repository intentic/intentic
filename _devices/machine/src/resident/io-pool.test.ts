import { capIoPool, IO_POOL_ENV, IO_POOL_THREADS } from "./io-pool.js";

describe("capIoPool", () => {
    it("sets the size on Windows while the pool starts, and takes it away once it has", async () => {
        const env: NodeJS.ProcessEnv = {};
        let seen: string | undefined;
        const done = capIoPool(env, "win32", async () => {
            seen = env[IO_POOL_ENV];
        });
        expect(done).toBeInstanceOf(Promise);
        await done;
        expect(seen).toBe(IO_POOL_THREADS);
        expect(env[IO_POOL_ENV]).toBeUndefined();
    });

    it("takes it away even when the stat that starts the pool fails", async () => {
        const env: NodeJS.ProcessEnv = {};
        await capIoPool(env, "win32", async () => {
            throw new Error("no such file");
        });
        expect(env[IO_POOL_ENV]).toBeUndefined();
    });

    it("leaves a size someone chose, and every other platform, alone", () => {
        const chosen: NodeJS.ProcessEnv = { [IO_POOL_ENV]: "16" };
        expect(capIoPool(chosen, "win32", async () => undefined)).toBeUndefined();
        expect(chosen[IO_POOL_ENV]).toBe("16");
        const linux: NodeJS.ProcessEnv = {};
        expect(capIoPool(linux, "linux", async () => undefined)).toBeUndefined();
        expect(linux[IO_POOL_ENV]).toBeUndefined();
    });
});
