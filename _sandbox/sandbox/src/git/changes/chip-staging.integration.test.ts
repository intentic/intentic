import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DISCARDABLE_SIDES, discardOutcome, scopedPaths, UNATTRIBUTED_ORIGIN } from "@intentic/sandbox-contract";

import { createApp } from "../../app.js";
import { clientFor } from "../../harness/route-client.testing.js";
import { tempWorkspace } from "../../harness/route-fakes.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { changedFiles } from "./changes.js";
import { commitIndex, discardPaths, stagePaths, unstagePaths } from "./changes-index.js";
import { indexEntries, writeIndexEntries } from "./chip-staging.js";

// The Changes panel's origin chips over the daemon's routes against a real repository, so what git ends up holding is
// what is asserted: a chip's on/off is exactly reversible, and a scoped discard touches what the panel's question names.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> =>
    (await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout;

// A workspace whose root is a real repo with one commit of `files`, and a client whose git verbs are the real ones.
const realRoot = async (files: Record<string, string>, origins: Record<string, readonly string[]>) => {
    const workspace = tempWorkspace([]);
    const dir = workspace.root;
    await sh(dir, "init", "-q");
    for (const [path, content] of Object.entries(files)) {
        await writeFile(join(dir, path), content);
    }
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-qm", "init");
    const app = () =>
        clientFor(
            createApp(
                services({
                    workspace,
                    git: {
                        ...services().git,
                        changedFiles,
                        stagePaths,
                        unstagePaths,
                        discardPaths,
                        commitIndex,
                        indexEntries,
                        writeIndexEntries,
                    },
                    agentOrigins: { forRepo: async () => origins, identify: () => ({}), metrics: () => ({}) },
                }),
            ),
        );
    return { dir, client: app() };
};

const stagedPaths = async (dir: string): Promise<string[]> => (await changedFiles(dir)).staged.map((change) => change.path).toSorted();
// The index's own copy of a file, which is what the next commit records.
const indexCopy = (dir: string, path: string): Promise<string> => sh(dir, "show", `:${path}`);

test("lighting then clearing the You chip leaves the owner's own staging as it was, a partial one included", async () => {
    const { dir, client } = await realRoot({ "mine.ts": "m1\n", "notes.ts": "a\nb\nc\nd\ne\nf\ng\nh\n", "agent.ts": "x\n" }, {
        "agent.ts": ["a1"],
    });
    // The owner's own work: mine.ts staged whole, notes.ts staged at an intermediate version (what `git add -p` leaves).
    await writeFile(join(dir, "mine.ts"), "m2\n");
    await sh(dir, "add", "mine.ts");
    await writeFile(join(dir, "notes.ts"), "A\nb\nc\nd\ne\nf\ng\nh\n");
    await sh(dir, "add", "notes.ts");
    await writeFile(join(dir, "notes.ts"), "A\nb\nc\nd\ne\nf\ng\nH-not-ready\n");
    await writeFile(join(dir, "agent.ts"), "y\n");
    await writeFile(join(dir, "also-mine.ts"), "new\n");

    await client.git.stage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    // Lit: every one of the owner's unstaged files is staged whole, the agent's left alone.
    expect(await stagedPaths(dir)).toEqual(["also-mine.ts", "mine.ts", "notes.ts"]);
    expect(await indexCopy(dir, "notes.ts")).toBe("A\nb\nc\nd\ne\nf\ng\nH-not-ready\n");

    await client.git.unstage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    // Cleared: the index as it was before the chip, the half-staged notes.ts at its half.
    expect(await stagedPaths(dir)).toEqual(["mine.ts", "notes.ts"]);
    expect(await indexCopy(dir, "notes.ts")).toBe("A\nb\nc\nd\ne\nf\ng\nh\n");
    expect(await indexCopy(dir, "mine.ts")).toBe("m2\n");
    // The new file the chip staged is untracked again, not deleted.
    expect((await changedFiles(dir)).unstaged).toContainEqual(expect.objectContaining({ path: "also-mine.ts", status: "added" }));
});

test("one on/off of the You chip mid-merge keeps the incoming branch's staged result and the merge itself", async () => {
    const { dir, client } = await realRoot({ "conflict.ts": "base\n", "incoming.ts": "base\n" }, {});
    const trunk = (await sh(dir, "branch", "--show-current")).trim();
    await sh(dir, "checkout", "-q", "-b", "side");
    await writeFile(join(dir, "conflict.ts"), "theirs\n");
    await writeFile(join(dir, "incoming.ts"), "from side\n");
    await sh(dir, "commit", "-qam", "side");
    await sh(dir, "checkout", "-q", trunk);
    await writeFile(join(dir, "conflict.ts"), "ours\n");
    await sh(dir, "commit", "-qam", "ours");
    await sh(dir, "merge", "side").catch(() => undefined);
    expect(await stagedPaths(dir)).toEqual(["incoming.ts"]);
    await writeFile(join(dir, "own-edit.ts"), "mine\n");

    await client.git.stage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    // A chip never resolves a conflict for the owner.
    expect((await changedFiles(dir)).conflicted.map((change) => change.path)).toEqual(["conflict.ts"]);
    await client.git.unstage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });

    expect(await stagedPaths(dir)).toEqual(["incoming.ts"]);
    await writeFile(join(dir, "conflict.ts"), "resolved\n");
    await sh(dir, "add", "conflict.ts");
    await sh(dir, "commit", "-qm", "merge side");
    expect(await sh(dir, "show", "HEAD:incoming.ts")).toBe("from side\n");
    expect((await sh(dir, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ")).toHaveLength(3);
});

test("clearing a chip leaves alone a file staged differently since, and everything once a commit took the staging", async () => {
    const { dir, client } = await realRoot({ "a.ts": "a1\n", "b.ts": "b1\n" }, {});
    await writeFile(join(dir, "a.ts"), "a2\n");
    await writeFile(join(dir, "b.ts"), "b2\n");
    await client.git.stage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    // The owner restages a.ts at a newer version by hand: that is their decision, which clearing must not undo.
    await writeFile(join(dir, "a.ts"), "a3\n");
    await sh(dir, "add", "a.ts");
    await client.git.unstage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    expect(await stagedPaths(dir)).toEqual(["a.ts"]);
    expect(await indexCopy(dir, "a.ts")).toBe("a3\n");

    // Lit again and committed: HEAD moved, so a late clear (a second tab, a stale click) takes nothing out.
    await client.git.stage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    await client.git.commit({ repo: "root", message: "chore: take it" });
    await writeFile(join(dir, "b.ts"), "b3\n");
    await sh(dir, "add", "b.ts");
    await client.git.unstage({ repo: "root", chip: UNATTRIBUTED_ORIGIN });
    expect(await stagedPaths(dir)).toEqual(["b.ts"]);
});

test("an agent's chip stages only that agent's files and gives back exactly them", async () => {
    const { dir, client } = await realRoot({ "agent.ts": "x\n", "mine.ts": "m1\n" }, { "agent.ts": ["a1"] });
    await writeFile(join(dir, "agent.ts"), "y\n");
    await writeFile(join(dir, "mine.ts"), "m2\n");
    await sh(dir, "add", "mine.ts");
    await client.git.stage({ repo: "root", chip: "a1" });
    expect(await stagedPaths(dir)).toEqual(["agent.ts", "mine.ts"]);
    await client.git.unstage({ repo: "root", chip: "a1" });
    expect(await stagedPaths(dir)).toEqual(["mine.ts"]);
});

// The panel builds its discard question from the scanned rows with the contract's scopedPaths and discardOutcome; the
// daemon resolves the scope it is sent with the same two. Read off a real scan, the question's list of files leaving
// the disk is exactly what the discard deletes, the owner's rename out of the agent's file included.
test("a discard under an origin deletes exactly the files the question built from the scan names", async () => {
    const body = Array.from({ length: 10 }, (_, line) => `export const v${line} = ${line};\n`).join("");
    const { dir, client } = await realRoot({ "util.ts": body, "other.ts": "o1\n" }, { "util.ts": ["a1"], "other.ts": ["a1"] });
    await writeFile(join(dir, "other.ts"), "o2\n");
    await sh(dir, "mv", "util.ts", "helpers.ts");
    await writeFile(join(dir, "helpers.ts"), `${body}export const ownersOwnNewWork = true;\n`);
    await sh(dir, "add", "helpers.ts");
    await writeFile(join(dir, "mine.ts"), "owner's own\n");

    const scanned = (await client.git.changes()).repos.find((repo) => repo.repo === "root");
    if (scanned === undefined) {
        throw new Error("root not scanned");
    }
    const asked = discardOutcome(scanned, scopedPaths(scanned, DISCARDABLE_SIDES, { origin: "a1" }, scanned.origins ?? {}));
    expect(asked).toEqual({ deletes: ["helpers.ts"], restores: ["util.ts", "other.ts"] });
    // Under "You" the same rename is not the owner's: neither the question nor the scope reaches it.
    const yours = scopedPaths(scanned, DISCARDABLE_SIDES, { origin: UNATTRIBUTED_ORIGIN }, scanned.origins ?? {});
    expect(yours).toEqual(["mine.ts"]);

    await client.git.discard({ repo: "root", scope: { origin: "a1" } });
    expect(existsSync(join(dir, "helpers.ts"))).toBe(false);
    expect(existsSync(join(dir, "util.ts"))).toBe(true);
    expect(existsSync(join(dir, "mine.ts"))).toBe(true);
});
