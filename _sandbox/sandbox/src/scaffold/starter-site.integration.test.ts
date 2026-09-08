import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { gitInit } from "@intentic/scaffold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../composition.js";
import { seedStarterSite, STARTER_BAKED_DIR, workspaceArrivedEmpty } from "./starter-site.js";

const exec = promisify(execFile);

// Exercises that a fresh workspace's starter site lands as a real git repo (history on /history) with the right package
// name, against real git and a real copy since the failures here are filesystem, not logic.

let root: string;
let baked: string;
let history: string;
let started: { key: string; spec: { command: string; cwd: string } }[];

// The baked tree as the image leaves it: one app under `_apps/`, node_modules already installed (a marker file stands
// in for real dependencies), and no .git; the daemon inits the repo itself.
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

// `arrivedEmpty` mirrors the boot-time verdict composition computed before any write, not a live directory check; the
// tests below depend on that distinction.
const services = (arrivedEmpty = true): Services =>
    ({
        workspace: { root },
        workspaceArrivedEmpty: arrivedEmpty,
        config: { historyRoot: history, zone: "sbx.test", connectToken: "", sandbox: { publicUrl: "" } },
        processes: { start: vi.fn((key: string, spec: { command: string; cwd: string }) => Promise.resolve(void started.push({ key, spec }))) },
    }) as unknown as Services;

beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-starter-"));
    root = join(base, "work");
    history = join(base, "history");
    baked = join(base, "baked");
    started = [];
    await mkdir(root, { recursive: true });
    // Mirrors the boot chain one step earlier: root is already a repo with its git dir on /history.
    await gitInit(root, join(history, "gits", "root"));
    await bakeStarter(baked);
});

afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
});

describe("seedStarterSite", () => {
    it("lands the baked site as its own repo and records it for autostart", async () => {
        expect(await seedStarterSite(services(), baked)).toEqual({ repo: "site" });

        const repo = join(root, "site");
        expect(existsSync(join(repo, "_apps", "landing", "src", "index.astro"))).toBe(true);
        expect(existsSync(join(repo, "node_modules", ".bin", "astro"))).toBe(true);
        expect(readFileSync(join(repo, ".git"), "utf8")).toContain(history);
        expect((await exec("git", ["-C", repo, "log", "--oneline"])).stdout).toContain("starter site");
        expect((await exec("git", ["-C", repo, "ls-files"])).stdout).not.toContain("node_modules");

        expect(readFileSync(join(history, "gits", "root", "info", "exclude"), "utf8")).toContain("/site/");

        expect(started).toEqual([]);
        expect(JSON.parse(readFileSync(join(root, ".intentic", "config", "autostart.json"), "utf8"))).toEqual({
            apps: [{ repo: "site", app: "landing", dev: "pnpm --filter {pkg} dev" }],
        });
    });

    it("does nothing on a workspace that already has one: a boot must never re-seed over the user's work", async () => {
        await seedStarterSite(services(), baked);
        await writeFile(join(root, "site", "_apps", "landing", "src", "index.astro"), "<h1>mine now</h1>\n");
        started = [];

        expect(await seedStarterSite(services(), baked)).toEqual({ skipped: "a site repo is already there" });
        expect(readFileSync(join(root, "site", "_apps", "landing", "src", "index.astro"), "utf8")).toContain("mine now");
        expect(started).toEqual([]);
    });

    // `.starter-site.incoming` is the seed's own staging name; a leftover one is discarded, not trusted as a finished
    // copy.
    it("throws away a stage left by a boot that died mid-copy", async () => {
        const stage = join(root, ".starter-site.incoming");
        await mkdir(join(stage, "_apps"), { recursive: true });
        await writeFile(join(stage, "half-written"), "");

        expect(await seedStarterSite(services(), baked)).toEqual({ repo: "site" });
        expect(existsSync(join(root, "site", "half-written"))).toBe(false);
        expect(existsSync(join(root, "site", "_apps", "landing", "package.json"))).toBe(true);
        expect(existsSync(stage)).toBe(false);
    });

    it("leaves a workspace that already has somebody's work in it alone", async () => {
        await mkdir(join(root, "my-project"), { recursive: true });

        expect(await seedStarterSite(services(false), baked)).toEqual({ skipped: "the workspace arrived with content" });
        expect(existsSync(join(root, "site"))).toBe(false);
        expect(started).toEqual([]);
    });

    it("does nothing when the image baked no starter: an older image simply opens empty", async () => {
        expect(await seedStarterSite(services(), join(baked, "absent"))).toEqual({ skipped: "no baked starter in this image" });
        expect(existsSync(join(root, "site"))).toBe(false);
        expect(started).toEqual([]);
    });

    // The path the Dockerfile writes to and this module reads from, in one place on each side. A rename that
    // touches only one of them would leave every new sandbox opening empty with nothing else failing, so the two
    // sides are read against each other here.
    it("reads the tree from the path the image bakes", () => {
        const dockerfile = readFileSync(join(packageRoot(import.meta.url), "Dockerfile"), "utf8");
        expect(/intentic scaffold add-app --dir (\S+)/.exec(dockerfile)?.[1]).toBe(STARTER_BAKED_DIR);
    });
});

// Must run before the daemon writes anything: it tells daemon furniture from user work by workspace contents alone.
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

    it("reads an AGENTS.md that was already there as somebody's work", async () => {
        await writeFile(join(root, "AGENTS.md"), "# how I work\n");

        expect(workspaceArrivedEmpty(root)).toBe(false);
    });

    it("reads a root it cannot list as no workspace to seed into", () => {
        expect(workspaceArrivedEmpty(join(root, "absent"))).toBe(false);
    });
});
