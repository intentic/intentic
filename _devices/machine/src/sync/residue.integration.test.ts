import { WORKSPACE_ROOT } from "@intentic/constants";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "bun:test";
import { IGNORES } from "./ssh.js";
import {
    absentInSandbox,
    clearConflictResidue,
    findDerivedHusks,
    ignoreMatcher,
    isDerivedHusk,
    isSafeRelativePath,
    isShellSafePath,
    sweepableHusks,
} from "./residue.js";

// The invariant every test here defends: nothing is removed that the session would have carried. The cases are the
// ones measured on a dogfooding machine — six package directories moved in the sandbox, each left standing on this
// device by a `node_modules` and a `.turbo` nobody wrote.

const ignored = ignoreMatcher(IGNORES);

describe("ignoreMatcher", () => {
    it("matches a bare pattern at every depth, the way Mutagen does", () => {
        expect(ignored(`node_modules`)).toBe(true);
        expect(ignored(`intentic/_extensions/acceptance/node_modules`)).toBe(true);
        expect(ignored(`a/b/c/.turbo`)).toBe(true);
    });

    it("keeps an anchored pattern at the root, where two directories share one name", () => {
        // The WORKSPACE's state dir is excluded wholesale; a repository's own committed `.intentic/` is content.
        expect(ignored(`.intentic`)).toBe(true);
        expect(ignored(`intentic/.intentic`)).toBe(false);
        expect(ignored(`intentic/.intentic/checks.json`)).toBe(false);
    });

    it("matches nothing for a pattern spelling it was never taught", () => {
        // The failure that matters is the one that widens deletion; an unreadable pattern must only narrow it.
        const exotic = ignoreMatcher([`**/build`, `!keep`, `src/*.log`]);
        expect(exotic(`build`)).toBe(false);
        expect(exotic(`src/a.log`)).toBe(false);
        expect(exotic(`keep`)).toBe(false);
    });

    it("leaves a real source path alone", () => {
        expect(ignored(`intentic/_extensions/acceptance/src/index.ts`)).toBe(false);
        expect(ignored(`package.json`)).toBe(false);
    });
});

describe("path guards", () => {
    it("refuses anything that could leave the synced folder", () => {
        for (const path of [``, `/etc/passwd`, `../outside`, `a/../../b`, `a/./b`, `a//b`, `a\\b`, `a\0b`]) {
            expect(isSafeRelativePath(path)).toBe(false);
        }
        expect(isSafeRelativePath(`intentic/_extensions/acceptance`)).toBe(true);
    });

    it("holds a path with a space out of the REMOTE probe rather than mangling it", () => {
        // ssh joins its argv into one string the far side re-parses: a space would become two paths.
        expect(isSafeRelativePath(`my folder/pkg`)).toBe(true);
        expect(isShellSafePath(`my folder/pkg`)).toBe(false);
        expect(isShellSafePath(`intentic/_extensions/acceptance`)).toBe(true);
        expect(isShellSafePath(`pkg;rm -rf /`)).toBe(false);
        expect(isShellSafePath(`pkg$(whoami)`)).toBe(false);
        expect(isShellSafePath(`-rf`)).toBe(false);
    });
});

let scratch: string | undefined;

const tree = async (layout: Record<string, string | null>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), `residue-`));
    scratch = root;
    for (const [path, content] of Object.entries(layout)) {
        const full = join(root, path);
        if (content === null) {
            await mkdir(full, { recursive: true });
            continue;
        }
        await mkdir(join(full, `..`), { recursive: true });
        await writeFile(full, content);
    }
    return root;
};

afterEach(async () => {
    if (scratch !== undefined) {
        await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    }
});

describe("isDerivedHusk", () => {
    it("is true for the shape that wedged the dogfooding machine: only build output left", async () => {
        const root = await tree({
            "pkg/node_modules/left-pad/index.js": `module.exports = 1;`,
            "pkg/.turbo": null,
            "pkg/.cache": null,
        });
        expect(await isDerivedHusk(root, `pkg`, ignored)).toBe(true);
    });

    it("is false the moment one file sync would have carried is in there", async () => {
        const root = await tree({ "pkg/node_modules/x.js": `1`, "pkg/README.md": `#` });
        expect(await isDerivedHusk(root, `pkg`, ignored)).toBe(false);
    });

    it("is false for a real file buried under directories that are themselves empty", async () => {
        const root = await tree({ "pkg/node_modules/x.js": `1`, "pkg/src/deep/keep.ts": `export {};` });
        expect(await isDerivedHusk(root, `pkg`, ignored)).toBe(false);
    });

    it("is true for a directory holding nothing but another husk", async () => {
        const root = await tree({ "group/pkg/dist/main.js": `1`, "group/pkg/.turbo": null });
        expect(await isDerivedHusk(root, `group`, ignored)).toBe(true);
    });

    it("is true for an empty directory: there is nothing in it to lose", async () => {
        const root = await tree({ empty: null });
        expect(await isDerivedHusk(root, `empty`, ignored)).toBe(true);
    });

    // The second defence, so a report that classified a repository as residue still removes nothing: `.git` is under
    // the same ignore patterns as `node_modules`, and reading those alone calls this directory empty.
    it("is false for a directory whose only content is a git repository", async () => {
        const root = await tree({ "pkg/.git/HEAD": `ref: refs/heads/main`, "pkg/node_modules/x.js": `1` });
        expect(await isDerivedHusk(root, `pkg`, ignored)).toBe(false);
    });

    it("is false for a path that cannot be read at all, rather than assuming", async () => {
        const root = await tree({ "pkg/README.md": `#` });
        expect(await isDerivedHusk(root, `nothing-here`, ignored)).toBe(false);
    });
});

describe("findDerivedHusks", () => {
    it("returns the outermost residue and nothing inside it", async () => {
        const root = await tree({
            "keep/src/index.ts": `export {};`,
            "keep/node_modules/x.js": `1`,
            "gone/node_modules/x.js": `1`,
            "gone/.turbo": null,
            "group/inner/dist/main.js": `1`,
            "group/other/package.json": `{}`,
        });
        const husks = await findDerivedHusks(root, ignored);
        // `gone` and `group/inner` are residue; `keep` holds real source and `group` holds a real package.
        expect([...husks].sort()).toEqual([`gone`, `group/inner`]);
    });

    // The sweep runs unprompted whenever a session is made from nothing, so this is the pass that would have taken
    // the four extension clones without anybody pressing anything.
    it("leaves a directory holding a git repository alone", async () => {
        const root = await tree({ "clone/.git/HEAD": `ref: refs/heads/main`, "clone/node_modules/x.js": `1`, "gone/dist/main.js": `1` });
        expect(await findDerivedHusks(root, ignored)).toEqual([`gone`]);
    });

    it("never returns the sync root, even when the whole folder reads as residue", async () => {
        const root = await tree({ "a/node_modules/x.js": `1`, "b/dist/y.js": `1` });
        // Every child is a husk, so the root is one too — and emptying the folder is not what this sweeps for.
        expect(await findDerivedHusks(root, ignored)).toEqual([]);
    });
});

describe("sweepableHusks", () => {
    // A sandbox mid-rebuild answers "absent" to everything; a present PARENT is what says a directory was really
    // removed from somewhere that still exists.
    it("keeps only residue whose parent the sandbox still has", () => {
        const absent = new Set([`intentic/_extensions/acceptance`, `orphan/pkg`, `orphan`]);
        expect(sweepableHusks([`intentic/_extensions/acceptance`, `orphan/pkg`], absent)).toEqual([`intentic/_extensions/acceptance`]);
    });

    it("sweeps nothing at all when the sandbox never answered", () => {
        expect(sweepableHusks([`pkg`], undefined)).toEqual([]);
    });

    it("treats a root-level directory's parent as present, since the sync root always is", () => {
        expect(sweepableHusks([`pkg`], new Set([`pkg`]))).toEqual([`pkg`]);
    });
});

describe("absentInSandbox", () => {
    it("asks in one call, about shell-safe paths only, and reads back what is missing", async () => {
        const seen: string[][] = [];
        const absent = await absentInSandbox(
            {
                run: async (_command, args) => {
                    seen.push([...args]);
                    return `pkg-a\n`;
                },
            },
            `intentic-sync-box`,
            WORKSPACE_ROOT,
            [`pkg-a`, `pkg-b`, `awkward name`],
        );
        expect(absent).toEqual(new Set([`pkg-a`]));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain(`pkg-a`);
        expect(seen[0]).toContain(`/work`);
        // The unaskable spelling never reaches the wire.
        expect(seen[0]).not.toContain(`awkward name`);
    });

    it("answers undefined when ssh failed, which must never read as 'the sandbox does not have it'", async () => {
        expect(await absentInSandbox({ run: async () => undefined }, `alias`, `/work`, [`pkg`])).toBeUndefined();
    });
});

describe("clearConflictResidue", () => {
    const quiet = (): void => {};

    it("clears the device's build output and leaves a real disagreement standing", async () => {
        const root = await tree({
            "gone/node_modules/x.js": `1`,
            "gone/.turbo": null,
            "disputed/README.md": `mine`,
        });
        const outcome = await clearConflictResidue({
            root,
            ignores: IGNORES,
            log: quiet,
            conflicts: [
                { path: `gone`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
                { path: `disputed/README.md`, local: `modified`, sandbox: `modified`, nature: `both-edited` },
            ],
        });
        expect(outcome.removed).toEqual([`gone`]);
        expect(outcome.standing).toBe(1);
        expect(await isDerivedHusk(root, `disputed`, ignored)).toBe(false);
    });

    it("refuses a path the report calls residue when the disk says otherwise", async () => {
        // The window between reading Mutagen's list and acting on it is the whole reason the disk is re-read.
        const root = await tree({ "gone/node_modules/x.js": `1`, "gone/notes.md": `written since` });
        const outcome = await clearConflictResidue({
            root,
            ignores: IGNORES,
            log: quiet,
            conflicts: [{ path: `gone`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` }],
        });
        expect(outcome.removed).toEqual([]);
        expect(outcome.standing).toBe(1);
    });

    it("leaves alone a conflict an older agent reported without a nature", async () => {
        const root = await tree({ "gone/node_modules/x.js": `1` });
        const outcome = await clearConflictResidue({
            root,
            ignores: IGNORES,
            log: quiet,
            conflicts: [{ path: `gone`, local: `created`, sandbox: `deleted` }],
        });
        expect(outcome.removed).toEqual([]);
        expect(outcome.standing).toBe(1);
    });

    it("refuses a path that would leave the synced folder", async () => {
        const root = await tree({ "pkg/node_modules/x.js": `1` });
        const outcome = await clearConflictResidue({
            root,
            ignores: IGNORES,
            log: quiet,
            conflicts: [{ path: `../elsewhere`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` }],
        });
        expect(outcome.removed).toEqual([]);
        expect(outcome.standing).toBe(1);
    });
});
