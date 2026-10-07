import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { announceRepoChange, startRepoWatch, subscribeRepoChanges } from "./repo-watch.js";

const run = promisify(execFile);

// An editor's /events stream subscribes while boot is still under way, before the watch exists; it must hear the
// repo set move once the watch is up, rather than have subscribed to nothing for the life of its connection.
test("a subscriber taken before the watch starts hears the repos it finds afterwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "repowatch-"));
    const heard: string[][] = [];
    const unsubscribe = subscribeRepoChanges((repos) => heard.push(repos));
    const stop = startRepoWatch(root, pino({ level: "silent" }));
    try {
        await mkdir(join(root, "app"));
        await run("git", ["init", "-q", "-b", "main"], { cwd: join(root, "app") });
        announceRepoChange();
        const deadline = Date.now() + 5000;
        while (!heard.some((repos) => repos.includes("app")) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(heard.some((repos) => repos.includes("app"))).toBe(true);
    } finally {
        stop();
        unsubscribe();
        await rm(root, { recursive: true, force: true });
    }
});
