import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitInit } from "@intentic/scaffold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../composition.js";
import { seedStarterSite, STARTER_BAKED_DIR, workspaceArrivedEmpty } from "./starter-site.js";

const exec = promisify(execFile);

/* WHAT A NEW USER'S FIRST TEN SECONDS DEPEND ON. The starter site is the only thing in a fresh workspace, and
 * it is worth nothing unless three things hold: the baked tree actually lands, it lands as a REPO shaped like
 * every other workspace repo (git dir on /history, so an agent in /work cannot destroy its history), and its
 * dev server is started with the app's real package name. Everything here runs against real git and a real
 * copy, because the failures this guards against are filesystem failures, not logic ones. */

let root: string;
let baked: string;
let history: string;
let started: { key: string; spec: { command: string; cwd: string } }[];
let routes: string[][];

// The baked tree, as the image leaves it: a monorepo shell with one app under `_apps/`, node_modules already
// installed (a marker file stands in for 300 MB of it), and NO .git — the daemon inits the repo itself.
const bakeStarter = async (dir: string): Promise<void> => {
    await mkdir(join(dir, "_apps", "landing", "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "starter", private: true }, undefined, 4)}\n`);
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await writeFile(join(dir, "node_modules", ".bin", "astro"), "#!/bin/sh\n");
    await writeFile(
        join(dir, "_apps", "landing", "package.json"),
        `${JSON.stringify({ name: "@app_/landing", private: true, scripts: { dev: "astro dev" } }, undefined, 4)}\n`,
    );
    await writeFile(join(dir, "_apps", "landing", "src", "index.astro"), "<h1>hello</h1>\n");
};

// `arrivedEmpty` is the verdict composition took before the daemon wrote anything (composition.ts). It is a
// composed fact rather than a live look at the directory, which is exactly what the tests below lean on.
const services = (arrivedEmpty = true): Services =>
    ({
        workspace: { root },
        workspaceArrivedEmpty: arrivedEmpty,
        config: { historyRoot: history, zone: "sbx.test", connectToken: "", sandbox: { publicUrl: "" } },
        processes: { start: vi.fn((key: string, spec: { command: string; cwd: string }) => Promise.resolve(void started.push({ key, spec }))) },
        ensurePreviewRoutes: vi.fn((labels: readonly string[]) => Promise.resolve(void routes.push([...labels]))),
    }) as unknown as Services;

beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-starter-"));
    root = join(base, "work");
    history = join(base, "history");
    baked = join(base, "baked");
    started = [];
    routes = [];
    await mkdir(root, { recursive: true });
    // The workspace as the boot chain leaves it one step earlier: root is already a repo, with its git dir on
    // /history, and its excludes were derived before any of this existed.
    await gitInit(root, join(history, "gits", "root"));
    await bakeStarter(baked);
});

afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
});

describe("seedStarterSite", () => {
    it("lands the baked site as its own repo and starts its dev server", async () => {
        expect(await seedStarterSite(services(), baked)).toEqual({ repo: "site" });

        const repo = join(root, "site");
        // The site itself, node_modules included: what makes the preview instant is that nothing installs here.
        expect(existsSync(join(repo, "_apps", "landing", "src", "index.astro"))).toBe(true);
        expect(existsSync(join(repo, "node_modules", ".bin", "astro"))).toBe(true);
        // A repo, with its git dir OUT of the tree: the in-tree .git is a pointer, the history is on /history.
        expect(readFileSync(join(repo, ".git"), "utf8")).toContain(history);
        expect((await exec("git", ["-C", repo, "log", "--oneline"])).stdout).toContain("starter site");
        // node_modules is ignored, so the first commit is the site's files rather than its dependencies.
        expect((await exec("git", ["-C", repo, "ls-files"])).stdout).not.toContain("node_modules");

        // Root's excludes now name the site, which is what stops root's own baseline commit (taken moments
        // later, in the same boot) from swallowing it as a gitlink.
        expect(readFileSync(join(history, "gits", "root", "info", "exclude"), "utf8")).toContain("/site/");

        // Started under the process manager's own key, from the repo root, filtered to the app's REAL package
        // name (the template's scope, read off disk, never assumed).
        expect(started).toHaveLength(1);
        expect(started[0]?.key).toBe("site--landing");
        expect(started[0]?.spec.cwd).toBe(repo);
        expect(started[0]?.spec.command).toContain("pnpm --filter @app_/landing dev");
        // And the preview hostname is minted, which has to happen before any browser resolves it.
        expect(routes).toEqual([["preview-site--landing"]]);
    });

    it("does nothing on a workspace that already has one: a boot must never re-seed over the user's work", async () => {
        await seedStarterSite(services(), baked);
        await writeFile(join(root, "site", "_apps", "landing", "src", "index.astro"), "<h1>mine now</h1>\n");
        started = [];

        expect(await seedStarterSite(services(), baked)).toEqual({ skipped: "a site repo is already there" });
        expect(readFileSync(join(root, "site", "_apps", "landing", "src", "index.astro"), "utf8")).toContain("mine now");
        expect(started).toEqual([]);
    });

    /* A boot killed mid-copy used to be permanent: the gate is "is the repo there", so the half-written tree
     * left behind was skipped as done by every boot after it. The copy therefore lands aside and is renamed in,
     * and a leftover stage is thrown away rather than trusted. */
    it("throws away a stage left by a boot that died mid-copy", async () => {
        const stage = join(root, ".starter-site.incoming");
        await mkdir(join(stage, "_apps"), { recursive: true });
        await writeFile(join(stage, "half-written"), "");

        expect(await seedStarterSite(services(), baked)).toEqual({ repo: "site" });
        expect(existsSync(join(root, "site", "half-written"))).toBe(false);
        expect(existsSync(join(root, "site", "_apps", "landing", "package.json"))).toBe(true);
        expect(existsSync(stage)).toBe(false);
    });

    /* A sandbox started over somebody's own checkout (their project handed in as the workspace) has no history
     * on /history either, so its first boot reads as fresh: the workspace's CONTENTS are what tell the two
     * apart, and a workspace with work in it is the one place a seeded site would be pure litter. */
    it("leaves a workspace that already has somebody's work in it alone", async () => {
        await mkdir(join(root, "my-project"), { recursive: true });

        expect(await seedStarterSite(services(false), baked)).toEqual({ skipped: "the workspace arrived with content" });
        expect(existsSync(join(root, "site"))).toBe(false);
        expect(started).toEqual([]);
    });

    /* THE DESKTOP INSTALL'S OWN BUG, as a test. The seed used to take the "did anything arrive here" reading
     * itself, at the moment it ran, which put it in a race with the daemon's own boot-time writes. The desktop
     * path lost that race every time: the setup computer's card is seeded detached, ahead of the boot chain, and
     * converging its skill files splices the managed index into AGENTS.md, a file that is not dotted. So the
     * seed read the daemon's own AGENTS.md as the user's work and every desktop install opened empty.
     *
     * The verdict is now composed before the daemon writes anything, so a file that appeared afterwards cannot
     * change it: that is what this asserts, with the racing writes already on disk. */
    it("seeds past files the daemon itself wrote after the workspace was read", async () => {
        await mkdir(join(root, ".intentic", "config"), { recursive: true });
        await mkdir(join(root, ".agents", "skills", "radarsu-rog"), { recursive: true });
        await mkdir(join(root, "refs"), { recursive: true });
        await writeFile(join(root, "AGENTS.md"), "<!-- intentic:skills -->\n## Skills\n<!-- /intentic:skills -->\n");

        expect(await seedStarterSite(services(), baked)).toEqual({ repo: "site" });
        expect(existsSync(join(root, "site", "_apps", "landing", "package.json"))).toBe(true);
    });

    it("does nothing when the image baked no starter: an older image simply opens empty", async () => {
        expect(await seedStarterSite(services(), join(baked, "absent"))).toEqual({ skipped: "no baked starter in this image" });
        expect(existsSync(join(root, "site"))).toBe(false);
        expect(started).toEqual([]);
    });

    // The path the Dockerfile writes to and this module reads from, in one place on each side. A rename that
    // touches only one of them leaves every new sandbox opening empty, with nothing failing anywhere.
    it("reads the tree from the path the image bakes", () => {
        expect(STARTER_BAKED_DIR).toBe("/opt/starter");
    });
});

/* THE READING ITSELF, which is only correct when it is taken before the daemon writes. Its job is to tell the
 * daemon's own furniture from the user's work, and the cases below are the three shapes a workspace can be in
 * when composition asks: empty but for the daemon's dotted state, holding somebody's project, or holding a file
 * whose name the daemon also writes later, which at THIS moment can only be the user's. */
describe("workspaceArrivedEmpty", () => {
    it("reads the daemon's own dotted state and the reference shelf as empty", async () => {
        await mkdir(join(root, ".intentic", "config"), { recursive: true });
        await mkdir(join(root, ".claude"), { recursive: true });
        await mkdir(join(root, "refs"), { recursive: true });

        expect(workspaceArrivedEmpty(root)).toBe(true);
    });

    it("reads anything else at all as somebody's work", async () => {
        await mkdir(join(root, "my-project"), { recursive: true });

        expect(workspaceArrivedEmpty(root)).toBe(false);
    });

    // Before the daemon has run, an AGENTS.md is the user's own operating notes, handed in with their folder.
    // It only becomes the daemon's file once the skills index is converged into it, which is why this question
    // is asked at composition and never again.
    it("reads an AGENTS.md that was already there as somebody's work", async () => {
        await writeFile(join(root, "AGENTS.md"), "# how I work\n");

        expect(workspaceArrivedEmpty(root)).toBe(false);
    });

    it("reads a root it cannot list as no workspace to seed into", () => {
        expect(workspaceArrivedEmpty(join(root, "absent"))).toBe(false);
    });
});
