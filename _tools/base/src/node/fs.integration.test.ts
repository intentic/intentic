import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, pathExists, queueOnFile, writeFileAtomic } from "./fs.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "fs-"));

describe("writeFileAtomic", () => {
    it("replaces the file whole and leaves no staging file beside it", async () => {
        const at = dir();
        const path = join(at, "device.json");
        writeFileSync(path, `{"links":[1,2,3]}`);

        await writeFileAtomic(path, `{"links":[]}`);

        expect(readFileSync(path, "utf8")).toBe(`{"links":[]}`);
        expect(readdirSync(at)).toEqual(["device.json"]);
    });

    // Every reader of these files acts on what it read, and the one that read a torn device.json wiped every link.
    it("never shows a reader anything but one whole version while writes race", async () => {
        const path = join(dir(), "state.json");
        const versions = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index, pad: "x".repeat(50_000) }));

        const seen: string[] = [];
        await Promise.all([
            ...versions.map(async (body) => await writeFileAtomic(path, body)),
            (async () => {
                for (let read = 0; read < 50; read++) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- reads interleaved with the writes on purpose
                    const body = await Bun.file(path)
                        .text()
                        .catch(() => versions[0] ?? "");
                    seen.push(body);
                }
            })(),
        ]);

        expect(seen.every((body) => versions.includes(body))).toBe(true);
    });

    it("creates the directories it writes into, and writes bytes as they are", async () => {
        const path = join(dir(), "a", "b", "blob.bin");

        await writeFileAtomic(path, new Uint8Array([0, 255, 10]));

        expect([...readFileSync(path)]).toEqual([0, 255, 10]);
    });

    it("removes its staging file when the rename fails, and says why", async () => {
        const at = dir();
        mkdirSync(join(at, "taken", "inside"), { recursive: true });

        await expect(writeFileAtomic(join(at, "taken"), "text")).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);

        expect(readdirSync(at)).toEqual(["taken"]);
    });

    describe.skipIf(process.platform === "win32")("modes", () => {
        it("gives the file exactly the mode asked for, whatever the umask would have cut", async () => {
            const path = join(dir(), "secret.json");
            writeFileSync(path, "{}", { mode: 0o644 });
            const umask = process.umask(0o077);
            try {
                await writeFileAtomic(path, "{}", 0o640);
            } finally {
                process.umask(umask);
            }

            expect(statSync(path).mode & 0o777).toBe(0o640);
        });

        it("leaves a new file's mode to the umask when none is asked for", async () => {
            const path = join(dir(), "plain.txt");
            const umask = process.umask(0o027);
            try {
                await writeFileAtomic(path, "text");
            } finally {
                process.umask(umask);
            }

            expect(statSync(path).mode & 0o777).toBe(0o640);
        });
    });
});

describe("queueOnFile", () => {
    it("runs one path's tasks one at a time, in the order they were queued", async () => {
        const path = join(dir(), "queued.json");
        const order: number[] = [];
        let active = 0;
        let most = 0;
        const task = (index: number) => async (): Promise<number> => {
            active += 1;
            most = Math.max(most, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(index);
            active -= 1;
            return index;
        };

        expect(await Promise.all([0, 1, 2].map((index) => queueOnFile(path, task(index))))).toEqual([0, 1, 2]);
        expect(order).toEqual([0, 1, 2]);
        expect(most).toBe(1);
    });

    it("hands the path on after a task that failed, and gives that failure to its own caller only", async () => {
        const path = join(dir(), "queued.json");
        const failed = queueOnFile(path, () => Promise.reject(new Error("first failed")));
        const next = queueOnFile(path, () => Promise.resolve("second ran"));

        await expect(failed).rejects.toThrow("first failed");
        expect(await next).toBe("second ran");
    });

    it("queues two spellings of one path together, and different paths apart", async () => {
        const at = dir();
        let release: () => void = () => {};
        const held = queueOnFile(join(at, "one.json"), () => new Promise<void>((resolve) => (release = resolve)));
        const order: string[] = [];
        // Spelled by hand: `join` would normalize the `..` away before the queue ever saw it.
        const sameFile = queueOnFile(`${at}/sub/../one.json`, async () => void order.push("same file"));
        await queueOnFile(join(at, "two.json"), async () => void order.push("other file"));

        expect(order).toEqual(["other file"]);
        release();
        await Promise.all([held, sameFile]);
        expect(order).toEqual(["other file", "same file"]);
    });
});

describe("pathExists", () => {
    it("answers whether a file or directory is there, and false below a file", async () => {
        const at = dir();
        writeFileSync(join(at, "file"), "");

        expect(await pathExists(join(at, "file"))).toBe(true);
        expect(await pathExists(at)).toBe(true);
        expect(await pathExists(join(at, "missing"))).toBe(false);
        expect(await pathExists(join(at, "file", "child"))).toBe(false);
    });
});

describe("freePort", () => {
    const bind = (port: number, host: string): Promise<void> =>
        new Promise((resolve, reject) => {
            const server = createServer();
            server.on("error", reject);
            server.listen(port, host, () => server.close(() => resolve()));
        });

    it("answers a loopback port the caller can then bind", async () => {
        const port = await freePort();

        expect(port).toBeGreaterThan(0);
        await expect(bind(port, "127.0.0.1")).resolves.toBeUndefined();
    });

    it("reserves on the host it is given", async () => {
        const port = await freePort("0.0.0.0");

        await expect(bind(port, "0.0.0.0")).resolves.toBeUndefined();
    });
});
