import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "@intentic/constants/node";
import { observeGitCommands } from "@intentic/base/git";
import { requires } from "@intentic/testing/requires";
import { connectNetd, type NetdLink } from "../../netd/netd-link.js";
import { statusPaths } from "../changes/changes.js";
import { netdCheckoutFeed, useCheckoutFeed } from "./checkout-feed.js";

// The daemon's reads against the real netd's change feed: this test is the Node netd supervises, over the same
// socket, and a status taken while the checkout's count stands still spawns no git.

const exec = promisify(execFile);
// INTENTIC_NETD_BINARY names a build outside the checkout's own target dir: CI's netd-check job, which builds netd
// with cargo into a cache directory, runs this file against that binary as its `netd` lane (ci.yml). The verify jobs
// build no Rust, so there it stands down.
const NETD = process.env["INTENTIC_NETD_BINARY"] ?? join(repoRoot(import.meta.url), "_sandbox/netd/target/debug/intentic-netd");
const built = requires(existsSync(NETD), `netd's debug build at ${NETD} (cargo build in _sandbox/netd)`, { lane: "netd" });

let runDir: string;
let netd: ChildProcess;
let link: NetdLink;

beforeAll(async () => {
    if (!built.runs) {
        return;
    }
    runDir = await mkdtemp(join(tmpdir(), "intentic-feed-netd-"));
    netd = spawn(NETD, ["--run-dir", runDir, "--", "sleep", "3600"], { stdio: "ignore", env: { ...process.env, NETD_LOG: "warn" } });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(runDir, "netd.sock"))) {
        if (Date.now() > deadline) {
            throw new Error("netd never opened its control socket");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    link = await connectNetd({
        path: join(runDir, "netd.sock"),
        answer: () => Promise.reject(new Error("not asked here")),
        onTunnel: () => undefined,
        onClose: () => undefined,
        onFault: () => undefined,
    });
    link.tell({ kind: "hello", build: "test", pid: process.pid });
    useCheckoutFeed(netdCheckoutFeed(link));
});

afterAll(async () => {
    useCheckoutFeed(undefined);
    link?.close();
    netd?.kill("SIGKILL");
    if (runDir !== undefined) {
        await rm(runDir, { recursive: true, force: true });
    }
});

test.skipIf(!built.runs)(built.title("an unchanged checkout's status is read once, and a write makes the next read git again"), async () => {
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
        const feed = netdCheckoutFeed(link);
        // The first read names the checkout; its count exists once netd has walked it.
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
