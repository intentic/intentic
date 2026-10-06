import { STATE_DIR } from "@intentic/constants";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, TurnReach } from "@intentic/sandbox-contract";
import { changedInstalls, reachWatch, snapshotInstalls, strandedClones } from "./turn-reach.js";

// The half of a turn's reach only git can tell, read off real checkouts: an installed extension is a git clone under
// .intentic/local/extensions/<capability id> whose pinned commit is its capability's ref, and a clone of its own is a
// repository the turn made inside its checkout, which a land never carries.

const MANIFEST = JSON.stringify({ publisher: "acme", name: "widgets", version: "1.0.0", engines: { intentic: ">=0.0.0" } });

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const put = (dir: string, path: string, content: string): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
};

// A committed repository at `dir`, answering with its HEAD.
const repoAt = (dir: string, files: Record<string, string>): string => {
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
        put(dir, path, content);
    }
    git(dir, "init", "-q", "--initial-branch=main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "start");
    return git(dir, "rev-parse", "HEAD");
};

const temps: string[] = [];
const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "turn-reach-"));
    temps.push(dir);
    return dir;
};
afterAll(() => {
    for (const dir of temps) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A workspace with one install, pinned where it was cloned.
const workspace = (): { readonly root: string; readonly install: string; readonly pin: string } => {
    const root = temp();
    const install = join(root, `${STATE_DIR}`, "local", "extensions", "acme-widgets");
    const pin = repoAt(install, { "intentic-extension.json": MANIFEST, "src/index.ts": "export default 1;\n" });
    return { root, install, pin };
};

describe("which installs a turn changed", () => {
    test("an edit, its shell's or its tools', is a change; one put back is none", async () => {
        const { root, install, pin } = workspace();
        const pins = new Map([["acme-widgets", pin]]);
        const before = await snapshotInstalls(root);
        put(install, "src/index.ts", "export default 2;\n");
        const edited = await snapshotInstalls(root);
        expect(changedInstalls(before, edited, pins)).toStrictEqual(["acme-widgets"]);

        git(install, "checkout", "--", "src/index.ts");
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual([]);
    });

    test("a file already dirty when the turn opened, edited again, is a change; left alone, it is none", async () => {
        const { root, install, pin } = workspace();
        const pins = new Map([["acme-widgets", pin]]);
        put(install, "src/index.ts", "export default 2;\n");
        const before = await snapshotInstalls(root);
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual([]);

        put(install, "src/index.ts", "export default 3; // and more\n");
        expect(changedInstalls(before, await snapshotInstalls(root), pins)).toStrictEqual(["acme-widgets"]);
    });

    test("a checkout that moved it off its pinned commit is a change; an update that lands on its new pin is none", async () => {
        const { root, install, pin } = workspace();
        const before = await snapshotInstalls(root);
        git(install, "checkout", "-q", "-b", "fix");
        put(install, "src/index.ts", "export default 4;\n");
        git(install, "commit", "-q", "-am", "fix");
        const after = await snapshotInstalls(root);
        expect(changedInstalls(before, after, new Map([["acme-widgets", pin]]))).toStrictEqual(["acme-widgets"]);
        // The same move, made by an update the owner pressed: the install now sits clean on the commit it is pinned to.
        expect(changedInstalls(before, after, new Map([["acme-widgets", git(install, "rev-parse", "HEAD")]]))).toStrictEqual([]);
    });
});

describe("clones of its own", () => {
    test("one holding uncommitted files or commits nobody else has is stranded; a clean one is not", async () => {
        const upstream = temp();
        repoAt(upstream, { "README.md": "# upstream\n" });
        const checkout = temp();
        repoAt(checkout, { "src/app.ts": "export {};\n" });
        git(checkout, "clone", "-q", upstream, "fork");
        git(checkout, "clone", "-q", upstream, "clean");
        put(join(checkout, "fork"), "README.md", "# changed\n");
        put(join(checkout, "fork"), "NEW.md", "new\n");
        git(join(checkout, "fork"), "checkout", "-q", "-b", "fix");
        put(join(checkout, "fork"), "FIX.md", "fix\n");
        git(join(checkout, "fork"), "add", "FIX.md");
        git(join(checkout, "fork"), "commit", "-q", "-m", "fix");
        put(checkout, "notes.txt", "not a clone\n");

        expect(await strandedClones([{ repo: "root", dir: checkout }])).toStrictEqual([{ dir: "fork", uncommitted: 2, unpushed: 1 }]);
        // A project repo's clone is named from the workspace's top, through the repo it sits in.
        expect(await strandedClones([{ repo: "intentic", dir: checkout }])).toStrictEqual([{ dir: "intentic/fork", uncommitted: 2, unpushed: 1 }]);
    });

    test("commits ahead of the upstream it follows count, and none of the ones it already has", async () => {
        const upstream = temp();
        repoAt(upstream, { "README.md": "# upstream\n" });
        const checkout = temp();
        repoAt(checkout, { "src/app.ts": "export {};\n" });
        git(checkout, "clone", "-q", upstream, "ext");
        put(join(checkout, "ext"), "A.md", "a\n");
        git(join(checkout, "ext"), "add", "A.md");
        git(join(checkout, "ext"), "commit", "-q", "-m", "a");
        expect(await strandedClones([{ repo: "root", dir: checkout }])).toStrictEqual([{ dir: "ext", uncommitted: 0, unpushed: 1 }]);
    });
});

describe("a turn's reach, open to close", () => {
    test("notes the install it changed by its manifest id, the push its frames saw, and drops its own frames for that install", async () => {
        const { root, install, pin } = workspace();
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
        const { root } = workspace();
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
