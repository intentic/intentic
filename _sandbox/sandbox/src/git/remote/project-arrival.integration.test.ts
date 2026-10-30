import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { createLogger } from "../../logger.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { ARRIVAL_WINDOW_MS, arrivalLanding, arrivalOpen, commitArrival, followProjectArrival } from "./project-arrival.js";
import { ensureProjectRepo, initialSubject } from "./project-repo.js";
import { ensureRootRepo } from "./root-repo.js";

// Real git in the container layout: what the Changes review would list is `git status`, which no stub can stand in for.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const NAME = "my-app";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A fresh project sandbox: root repo and the folder's repo born before file sync has delivered anything.
const freshSandbox = async (): Promise<{ root: string; project: string }> => {
    const base = await mkdtemp(join(tmpdir(), "project-arrival-"));
    tempDirs.push(base);
    const root = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(root, { recursive: true });
    await ensureRootRepo(workspacePaths(root), historyRoot);
    await ensureProjectRepo(workspacePaths(root), historyRoot, NAME);
    return { root, project: join(root, NAME) };
};

// What file sync's first copy writes.
const deliver = async (project: string): Promise<void> => {
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(project, "src", "index.ts"), "export {};\n");
};

const subjects = async (dir: string): Promise<string[]> => (await git(dir, "log", "--format=%s")).split("\n");

test("what the first copy delivered is committed under the arrival subject, so the review opens clean", async () => {
    const { root, project } = await freshSandbox();
    await deliver(project);
    expect(await git(project, "status", "--porcelain")).not.toBe("");

    expect(await commitArrival(root, NAME, Date.now())).toBe(true);

    expect(await git(project, "status", "--porcelain")).toBe("");
    expect(await subjects(project)).toEqual([initialSubject(NAME), initialSubject(NAME)]);
    expect((await git(project, "ls-files")).split("\n").sort()).toEqual(["package.json", "src/index.ts"]);
    // Nothing more arrived: no empty commit.
    expect(await commitArrival(root, NAME, Date.now())).toBe(false);
});

// A turn's or a land's commit ends the arrival: what changes after it is the owner's to see.
test("a commit of anyone else's closes the arrival for good", async () => {
    const { root, project } = await freshSandbox();
    await deliver(project);
    await git(project, "add", "-A");
    await git(project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Your my-app folder as it stands");
    await writeFile(join(project, "later.txt"), "an edit\n");

    expect(await arrivalOpen(project, NAME, Date.now())).toBe(false);
    expect(await commitArrival(root, NAME, Date.now())).toBe(false);
    expect(await git(project, "status", "--porcelain")).toBe("?? later.txt");
});

test("past the window, a quiet folder is no longer read as arriving", async () => {
    const { root, project } = await freshSandbox();
    await deliver(project);

    expect(await commitArrival(root, NAME, Date.now() + ARRIVAL_WINDOW_MS + 1000)).toBe(false);
    expect(await git(project, "status", "--porcelain")).not.toBe("");
});

// The root repo's own files are its baseline's business; the folder's repo is the only one touched.
test("following the arrival commits once the folder goes quiet, and only on batches that reach the folder", async () => {
    const { root, project } = await freshSandbox();
    const listeners = new Set<(paths: string[]) => void>();
    let subscribed: () => void = () => undefined;
    const armed = new Promise<void>((resolve) => {
        subscribed = resolve;
    });
    let landings = 0;
    const stop = followProjectArrival({
        workspaceRoot: root,
        name: NAME,
        withRepoLock: (_repo, task) => task(),
        subscribe: (next) => {
            listeners.add(next);
            subscribed();
            return () => listeners.delete(next);
        },
        logger: createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" }),
        landed: () => {
            landings += 1;
        },
        quietMs: 50,
    });
    const announce = (paths: string[]): void => {
        for (const listener of listeners) {
            listener(paths);
        }
    };
    try {
        // Subscribed once the arrival is read open; the start's own quiet finds nothing to commit.
        await armed;
        // The callback follows the Git work, which can outlast the quiet timer on a busy runner.
        await waitFor(() => expect(landings).toBe(1), SETTLES);
        // The start's quiet ran and found nothing: the folder is not landing, and the review reads it as it stands.
        expect(arrivalLanding(NAME)).toBe(false);
        const landingsBefore = landings;
        await deliver(project);
        // Another folder's batch moves nothing.
        announce(["elsewhere/file.txt"]);
        expect(arrivalLanding(NAME)).toBe(false);
        expect(await git(project, "status", "--porcelain")).not.toBe("");
        announce([`${NAME}/package.json`, `${NAME}/src/index.ts`]);
        // Mid-copy: the review leaves the folder out until the quiet commit has filed it.
        expect(arrivalLanding(NAME)).toBe(true);
        await waitFor(() => expect(landings).toBe(landingsBefore + 1), SETTLES);
        expect(arrivalLanding(NAME)).toBe(false);
        expect(landings).toBe(landingsBefore + 1);
        expect(await git(project, "status", "--porcelain")).toBe("");
        expect(await subjects(project)).toEqual([initialSubject(NAME), initialSubject(NAME)]);
    } finally {
        stop();
    }
    expect(listeners.size).toBe(0);
});
