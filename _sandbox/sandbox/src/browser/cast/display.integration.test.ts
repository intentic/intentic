import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { presenceOf } from "./display.js";

// Which display numbers the allocator may claim. Getting this wrong is silent: claiming a number a live server still
// owns unlinks that server's socket, and every respawn then dies on "server already running" with the number gone for
// good — the display picks no new number, so every browser after it fails.

// Outside FIRST..LAST, so a real allocation in this sandbox can never race the sockets bound here.
const FILE_ONLY = 901;
const ABSTRACT_ONLY = 902;
const STALE = 903;
const NOBODY = 904;

const socketPath = (number: number): string => `/tmp/.X11-unix/X${number}`;

const listeners: Server[] = [];

const listenAt = async (path: string): Promise<void> => {
    const server = createServer();
    listeners.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
    });
};

afterEach(async () => {
    await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const number of [FILE_ONLY, ABSTRACT_ONLY, STALE, NOBODY]) {
        rmSync(socketPath(number), { force: true });
    }
});

describe("presenceOf", () => {
    test("a number nothing is bound on is free", async () => {
        await expect(presenceOf(NOBODY)).resolves.toBe("free");
    });

    test("a live server on the socket file is usable", async () => {
        await listenAt(socketPath(FILE_ONLY));
        await expect(presenceOf(FILE_ONLY)).resolves.toBe("usable");
    });

    // The regression: Xvfb binds the abstract socket too, and only that one survives its file being unlinked. Probing
    // the file alone called this number free, and claiming it left a live display nothing could reach.
    test("a server holding only the abstract socket still owns the number", async () => {
        await listenAt(`\0${socketPath(ABSTRACT_ONLY)}`);
        await expect(presenceOf(ABSTRACT_ONLY)).resolves.toBe("usable");
    });

    // The case the file probe exists for: /tmp outlives a container stop, so a socket with no listener behind it is a
    // number to reclaim, not to skip forever. SIGKILL because a closed server unlinks its file, leaving nothing stale.
    test("a socket file with nothing behind it is free", async () => {
        const path = socketPath(STALE);
        const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)},()=>console.log("up"))`]);
        await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        expect(existsSync(path)).toBe(true);
        await expect(presenceOf(STALE)).resolves.toBe("free");
    });
});
