import { STATE_DIR } from "@intentic/constants";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { TurnReach } from "@intentic/sandbox-contract/schemas/agents";
import { changedInstalls, reachWatch, snapshotInstalls, strandedClones } from "./turn-reach.js";

// The half of a turn's reach only git can tell, read off real checkouts: an installed extension is a git clone under
// .intentic/local/extensions/<capability id> whose pinned commit is its capability's ref, and a clone of its own is a
// repository the turn made inside its checkout, which a land never carries.

const MANIFEST = JSON.stringify({ publisher: "acme", name: "widgets", version: "1.0.0", engines: { intentic: ">=0.0.0" } });

// A git of the test's own: this file shares its bun worker, and so its environment and its HOME, with every other suite
// in the run (all 517 of the daemon's, when the test pool leaves room for one worker), so it reads no config, ignore or
// attributes file but its own, and no GIT_* another suite left behind. Asynchronous and bounded: run 38088630519's
// synchronous `git add -A` hung there, holding the whole worker for 120s a test, where this fails in 30s and stalls
// nothing.
const gitHome = mkdtempSync(join(tmpdir(), "turn-reach-home-"));
const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    HOME: gitHome,
    XDG_CONFIG_HOME: join(gitHome, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
};
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const child = run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        timeout: 30_000,
    });
    child.child?.stdin?.end();
    return (await child).stdout.trim();
};

const put = (dir: string, path: string, content: string): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
};

// A committed repository at `dir`, answering with its HEAD.
const repoAt = async (dir: string, files: Record<string, string>): Promise<string> => {
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
        put(dir, path, content);
    }
    await git(dir, "init", "-q", "--initial-branch=main");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "start");
    return git(dir, "rev-parse", "HEAD");
};

const temps: string[] = [];
const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "turn-reach-"));
    temps.push(dir);
    return dir;
};
afterAll(() => {
    for (const dir of [...temps, gitHome]) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A workspace with one install, pinned where it was cloned.
const workspace = async (): Promise<{ readonly root: string; readonly install: string; readonly pin: string }> => {
    const root = temp();
    const install = join(root, `${STATE_DIR}`, "local", "extensions", "acme-widgets");
    const pin = await repoAt(install, { "intentic-extension.json": MANIFEST, "src/index.ts": "export default 1;\n" });
    return { root, install, pin };
};

describe("which installs a turn changed", () => {
    test("an edit, its shell's or its tools', is a change; one put back is none", async () => {
        const { root, install, pin } = await workspace();
        const pins = new Map([["acme-widgets", pin]]);
        const before = await snapshotInstalls(root);
        put(install, "src/index.ts", "export default 2;\n");
        const edited = await snapshotInstalls(root);
        expect(changedInstalls(before, edited, pins)).toStrictEqual(["acme-widgets"]);

        await git(install, "checkout", "--", "src/index.ts");
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual([]);
    });

    test("a file already dirty when the turn opened, edited again, is a change; left alone, it is none", async () => {
        const { root, install, pin } = await workspace();
        const pins = new Map([["acme-widgets", pin]]);
        put(install, "src/index.ts", "export default 2;\n");
        const before = await snapshotInstalls(root);
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual([]);

        put(install, "src/index.ts", "export default 3; // and more\n");
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual(["acme-widgets"]);
    });

    test("a checkout that moved it off its pinned commit is a change; an update that lands on its new pin is none", async () => {
        const { root, install, pin } = await workspace();
        const before = await snapshotInstalls(root);
        await git(install, "checkout", "-q", "-b", "fix");
        put(install, "src/index.ts", "export default 4;\n");
        await git(install, "commit", "-q", "-am", "fix");
        const after = await snapshotInstalls(root);
        expect(changedInstalls(before, after, new Map([["acme-widgets", pin]]))).toStrictEqual(["acme-widgets"]);
        // The same move, made by an update the owner pressed: the install now sits clean on the commit it is pinned to.
        expect(changedInstalls(before, after, new Map([["acme-widgets", await git(install, "rev-parse", "HEAD")]]))).toStrictEqual([]);
    });
});

describe("clones of its own", () => {
    test("one holding uncommitted files or commits nobody else has is stranded; a clean one is not", async () => {
        const upstream = temp();
        await repoAt(upstream, { "README.md": "# upstream\n" });
        const checkout = temp();
        await repoAt(checkout, { "src/app.ts": "export {};\n" });
        await git(checkout, "clone", "-q", upstream, "fork");
        await git(checkout, "clone", "-q", upstream, "clean");
        put(join(checkout, "fork"), "README.md", "# changed\n");
        put(join(checkout, "fork"), "NEW.md", "new\n");
        await git(join(checkout, "fork"), "checkout", "-q", "-b", "fix");
        put(join(checkout, "fork"), "FIX.md", "fix\n");
        await git(join(checkout, "fork"), "add", "FIX.md");
        await git(join(checkout, "fork"), "commit", "-q", "-m", "fix");
        put(checkout, "notes.txt", "not a clone\n");

        expect(await strandedClones([{ repo: "root", dir: checkout }])).toStrictEqual([{ dir: "fork", uncommitted: 2, unpushed: 1 }]);
        // A project repo's clone is named from the workspace's top, through the repo it sits in.
        expect(await strandedClones([{ repo: "intentic", dir: checkout }])).toStrictEqual([{ dir: "intentic/fork", uncommitted: 2, unpushed: 1 }]);
    });

    test("commits ahead of the upstream it follows count, and none of the ones it already has", async () => {
        const upstream = temp();
        await repoAt(upstream, { "README.md": "# upstream\n" });
        const checkout = temp();
        await repoAt(checkout, { "src/app.ts": "export {};\n" });
        await git(checkout, "clone", "-q", upstream, "ext");
        put(join(checkout, "ext"), "A.md", "a\n");
        await git(join(checkout, "ext"), "add", "A.md");
        await git(join(checkout, "ext"), "commit", "-q", "-m", "a");
        expect(await strandedClones([{ repo: "root", dir: checkout }])).toStrictEqual([{ dir: "ext", uncommitted: 0, unpushed: 1 }]);
    });
});

describe("a turn's reach, open to close", () => {
    test("notes the install it changed by its manifest id, the push its frames saw, and drops its own frames for that install", async () => {
        const { root, install, pin } = await workspace();
        const sent: { id: string; reach: TurnReach | undefined }[] = [];
        const capabilities = [
            { id: "acme-widgets", kind: "extension", config: { url: "https://github.com/acme/widgets.git", ref: pin } } as Capability,
        ];
        const watch = reachWatch(
            {
                workspace: { root },
                capabilities: { list: async () => capabilities },
                conversations: {
                    send: (id: string, event: { kind: string; reach?: TurnReach }) => {
                        sent.push({ id, reach: event.reach });
                        return { settled: Promise.resolve(undefined) };
                    },
                },
                logger: { debug: () => {}, warn: () => {} },
            } as never,
            "conv-1",
        );
        await watch.open();
        put(install, "src/index.ts", "export default 2;\n");
        watch.framed({
            live: [`${STATE_DIR}/local/extensions/acme-widgets/src/index.ts`, `${STATE_DIR}/local/state.json`],
            published: [{ dir: "extensions/widgets", remote: "origin", branch: "main", command: "git -C extensions/widgets push origin main" }],
        });
        await watch.close([]);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.id).toBe("conv-1");
        expect(sent[0]?.reach).toMatchObject({
            live: [{ path: `${STATE_DIR}/local/extensions/acme-widgets`, extension: "acme.widgets" }, { path: `${STATE_DIR}/local/state.json` }],
            published: [{ dir: "extensions/widgets", remote: "origin", branch: "main", command: "git -C extensions/widgets push origin main" }],
        });
    });

    test("notes nothing for a turn that left everything where it found it", async () => {
        const { root } = await workspace();
        const sent: (TurnReach | undefined)[] = [];
        const watch = reachWatch(
            {
                workspace: { root },
                capabilities: { list: async () => [] },
                conversations: { send: (_id: string, event: { reach?: TurnReach }) => void sent.push(event.reach) },
                logger: { debug: () => {}, warn: () => {} },
            } as never,
            "conv-2",
        );
        await watch.open();
        await watch.close([]);
        expect(sent).toStrictEqual([undefined]);
    });
});
