import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "@intentic/constants/node";
import { observeGitCommands } from "@intentic/scaffold";
import { connectFront, type FrontLink } from "../../front/front-link.js";
import { statusPaths } from "../changes/changes.js";
import { frontCheckoutFeed, useCheckoutFeed } from "./checkout-feed.js";

// The daemon's reads against the real front's change feed: this test is the Node the front supervises, over the same
// lane, and a status taken while the checkout's count stands still spawns no git. Skipped where the front is unbuilt.

const exec = promisify(execFile);
const FRONT = join(repoRoot(import.meta.url), "_sandbox/front/target/debug/intentic-front");

let runDir: string;
let front: ChildProcess;
let link: FrontLink;

beforeAll(async () => {
    if (!existsSync(FRONT)) {
        return;
    }
    runDir = await mkdtemp(join(tmpdir(), "intentic-feed-front-"));
    front = spawn(FRONT, ["--run-dir", runDir, "--", "sleep", "3600"], { stdio: "ignore", env: { ...process.env, FRONT_LOG: "warn" } });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(runDir, "front.sock"))) {
        if (Date.now() > deadline) {
            throw new Error("the front never opened its control socket");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    link = await connectFront({
        path: join(runDir, "front.sock"),
        answer: () => Promise.reject(new Error("not asked here")),
        onTunnel: () => undefined,
        onClose: () => undefined,
    });
    link.tell({ kind: "hello", build: "test", pid: process.pid });
    useCheckoutFeed(frontCheckoutFeed(link));
});

afterAll(async () => {
    useCheckoutFeed(undefined);
    link?.close();
    front?.kill("SIGKILL");
    if (runDir !== undefined) {
        await rm(runDir, { recursive: true, force: true });
    }
});

test.skipIf(!existsSync(FRONT))("an unchanged checkout's status is read once, and a write makes the next read git again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-feed-repo-"));
    try {
        await exec("git", ["-C", dir, "init", "-q"]);
        await writeFile(join(dir, "a.txt"), "a\n");
        const runs: string[] = [];
        observeGitCommands(({ dir: at }) => {
            if (at === dir) {
                runs.push(at);
            }
        });
        const feed = frontCheckoutFeed(link);
        // The first read names the checkout; its count exists once the front has walked it.
        expect(await statusPaths(dir)).toEqual(["a.txt"]);
        const deadline = Date.now() + 5_000;
        while ((await feed.generation(dir)) === undefined) {
            expect(Date.now()).toBeLessThan(deadline);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await statusPaths(dir);
        const settled = runs.length;
        for (let read = 0; read < 5; read++) {
            expect(await statusPaths(dir)).toEqual(["a.txt"]);
        }
        expect(runs.length).toBe(settled);
        await writeFile(join(dir, "b.txt"), "b\n");
        expect((await statusPaths(dir)).toSorted()).toEqual(["a.txt", "b.txt"]);
        expect(runs.length).toBe(settled + 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
