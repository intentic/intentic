import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { pushLanded } from "./push-landed.js";

// The back-up rule over real git (whether a branch tracks a remote is git's to say), with the push runs faked: what is
// decided here is which repositories are pushed and how, not how a push goes (git/ops/push-run.integration.test.ts).

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const made: string[] = [];
afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-push-landed-"));
    made.push(dir);
    return dir;
};

// A repo on `main` with one commit; `tracking` clones it from a bare origin, so its branch tracks `origin/main`.
const repo = async (tracking: boolean): Promise<string> => {
    const source = await temp();
    await sh(source, "init", "-q", "-b", "main");
    await writeFile(join(source, "a.txt"), "one\n");
    await sh(source, "add", "-A");
    await sh(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    if (!tracking) {
        return source;
    }
    const origin = await temp();
    await exec("git", ["clone", "-q", "--bare", source, origin]);
    const clone = await temp();
    await exec("git", ["clone", "-q", origin, clone]);
    return clone;
};

const VERSION: Rule = { id: "auto-version", label: "Save", moment: "agent.landed", action: { kind: "builtin", name: "version-landed" }, enabled: true };
const PUSH: Rule = { id: "auto-push", label: "Back up", moment: "agent.landed", action: { kind: "builtin", name: "push-landed" }, enabled: true };

interface Started {
    readonly repo: string;
    readonly dir: string;
    readonly again: boolean | undefined;
}

const services = (dirs: Readonly<Record<string, string>>) => {
    const started: Started[] = [];
    const fired: string[] = [];
    const fake = unstubbed<Pick<Services, "agentWorktrees" | "pushRuns" | "ruleFirings" | "logger">>("services", {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: (id) => dirs[id] ?? `/missing/${id}` }),
        pushRuns: unstubbed<Services["pushRuns"]>("pushRuns", {
            start: async (repoId, dir, options) => {
                started.push({ repo: repoId, dir, again: options.again });
            },
        }),
        ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", {
            stamp: async (id) => {
                fired.push(id);
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {} }),
    });
    return { fake, started, fired };
};

test("without the back-up rule a land's version is pushed nowhere", async () => {
    const dir = await repo(true);
    const { fake, started, fired } = services({ root: dir });
    await pushLanded(fake, [VERSION], ["root"]);
    expect(started).toEqual([]);
    expect(fired).toEqual([]);
});

test("with it, each committed repository whose branch tracks a remote is pushed, asking for one more if one runs", async () => {
    const app = await repo(true);
    const site = await repo(true);
    const { fake, started, fired } = services({ app, site });
    await pushLanded(fake, [VERSION, PUSH], ["app", "site"]);
    expect(started).toEqual([
        { repo: "app", dir: app, again: true },
        { repo: "site", dir: site, again: true },
    ]);
    expect(fired).toEqual(["auto-push", "auto-push"]);
});

// Publishing a branch the remote does not have is the owner's call, made once with Back up.
test("a repository whose branch tracks no remote branch is left alone", async () => {
    const local = await repo(false);
    const tracked = await repo(true);
    const { fake, started } = services({ local, tracked });
    await pushLanded(fake, [VERSION, PUSH], ["local", "tracked"]);
    expect(started.map((run) => run.repo)).toEqual(["tracked"]);
});

test("a rule narrowed to one repository pushes that one alone, and a switched-off rule pushes none", async () => {
    const app = await repo(true);
    const site = await repo(true);
    const { fake, started } = services({ app, site });
    await pushLanded(fake, [VERSION, { ...PUSH, when: { repo: "site" } }], ["app", "site"]);
    expect(started.map((run) => run.repo)).toEqual(["site"]);

    const off = services({ app, site });
    await pushLanded(off.fake, [VERSION, { ...PUSH, enabled: false }], ["app", "site"]);
    expect(off.started).toEqual([]);
});

test("a push that cannot start is the log's line, and the next repository still goes", async () => {
    const app = await repo(true);
    const site = await repo(true);
    const { fake, started } = services({ app, site });
    const failing = {
        ...fake,
        pushRuns: unstubbed<Services["pushRuns"]>("pushRuns", {
            start: async (repoId, dir, options) => {
                if (repoId === "app") {
                    throw new Error("terminal gone");
                }
                started.push({ repo: repoId, dir, again: options.again });
            },
        }),
    };
    await pushLanded(failing, [VERSION, PUSH], ["app", "site"]);
    expect(started.map((run) => run.repo)).toEqual(["site"]);
});
