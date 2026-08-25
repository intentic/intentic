import { describe, expect, it } from "vitest";
import type { ListeningPort } from "../ports/port-scan.js";
import { createPanelUpstreamResolver, panelDirOf, resolvePanelUpstream } from "./panel-upstream.js";

const ROOT = "/work";
const REPOS = ["app", "intentic", "scratch/notes"];
const DIRS = REPOS.map((repo) => `${ROOT}/${repo}`);

const listener = (port: number, cwd?: string, forwardable = true): ListeningPort => ({
    port,
    host: "127.0.0.1",
    forwardable,
    ...(cwd === undefined ? {} : { cwd }),
});

const panel = (repo: string, listeners: readonly ListeningPort[], assignedPort?: number) => ({
    dir: `${ROOT}/${repo}`,
    siblings: DIRS,
    listeners,
    assignedPort,
});

describe("what a panel hostname resolves to", () => {
    it("prefers the assigned port whenever something is on it, even with no cwd to attribute it by", () => {
        expect(resolvePanelUpstream(panel("app", [listener(33199)], 33199))).toEqual({ state: "serving", port: 33199, assigned: true });
    });

    it("falls back to the single port the repo really bound, whoever started it", () => {
        // The scaffolded case inverted: PORT was injected and ignored, or nobody injected anything because the
        // dev server was started by hand in a terminal. Either way the repo is answering at ONE address.
        expect(resolvePanelUpstream(panel("app", [listener(3000, "/work/app")], 33199))).toEqual({ state: "serving", port: 3000, assigned: false });
        expect(resolvePanelUpstream(panel("app", [listener(3000, "/work/app")]))).toEqual({ state: "serving", port: 3000, assigned: false });
    });

    it("names the servers instead of picking one when the repo's dev command fans out", () => {
        const upstream = resolvePanelUpstream(
            panel(
                "intentic",
                [
                    listener(47145, "/work/intentic/_editor/web"),
                    listener(4321, "/work/intentic/_site/site"),
                    listener(6480, "/work/intentic/_platform/api"),
                ],
                33199,
            ),
        );
        expect(upstream).toEqual({
            state: "several",
            servers: [
                { port: 4321, dir: "_site/site" },
                { port: 6480, dir: "_platform/api" },
                { port: 47145, dir: "_editor/web" },
            ],
        });
    });

    it("keeps one server per package, so a Vite's HMR and optimizer sockets don't read as three apps", () => {
        expect(resolvePanelUpstream(panel("app", [listener(3000, "/work/app"), listener(3001, "/work/app"), listener(3002, "/work/app")]))).toEqual({
            state: "serving",
            port: 3000,
            assigned: false,
        });
    });

    it("leaves a nested repo's servers to that repo", () => {
        const nested = [listener(5000, "/work/scratch/notes")];
        expect(resolvePanelUpstream(panel("scratch/notes", nested))).toEqual({ state: "serving", port: 5000, assigned: false });
        // `/work/app` is not its parent; the one that IS (a repo cloned inside another) must not swallow it.
        expect(resolvePanelUpstream({ dir: "/work", siblings: DIRS, listeners: nested, assignedPort: undefined })).toEqual({ state: "stopped" });
    });

    it("ignores a bind nothing here could dial (a loopback alias)", () => {
        expect(resolvePanelUpstream(panel("app", [listener(3000, "/work/app", false)]))).toEqual({ state: "stopped" });
    });

    it("separates starting from stopped by whether the daemon assigned a port at all", () => {
        expect(resolvePanelUpstream(panel("app", [], 33199))).toEqual({ state: "starting" });
        expect(resolvePanelUpstream(panel("app", []))).toEqual({ state: "stopped" });
    });
});

describe("whose directory a panel key names", () => {
    it("reads a repo key, including a nested repo's escaped form", () => {
        expect(panelDirOf(ROOT, REPOS, "app")).toBe("/work/app");
        expect(panelDirOf(ROOT, REPOS, "scratch--notes")).toBe("/work/scratch/notes");
    });

    it("reads `<repo>--<app>` as one app instance of a monorepo", () => {
        expect(panelDirOf(ROOT, REPOS, "intentic--shop")).toBe("/work/intentic/_apps/shop");
    });

    it("answers nothing for a key no repo in the workspace owns", () => {
        expect(panelDirOf(ROOT, REPOS, "ghost")).toBeUndefined();
        expect(panelDirOf(ROOT, REPOS, "ghost--web")).toBeUndefined();
    });
});

describe("the live resolver", () => {
    it("shares one scan across a burst of requests, then re-reads once the window passes", async () => {
        let scans = 0;
        const resolver = createPanelUpstreamResolver({
            workspaceRoot: ROOT,
            repos: () => Promise.resolve(REPOS),
            listeners: () => {
                scans += 1;
                return Promise.resolve([listener(3000, "/work/app")]);
            },
            portOf: () => undefined,
            ttlMs: 0,
        });
        const burst = await Promise.all([resolver("app"), resolver("app"), resolver("app")]);
        expect(burst).toEqual(Array.from({ length: 3 }, () => ({ state: "serving", port: 3000, assigned: false })));
        expect(scans).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 2));
        await resolver("app");
        expect(scans).toBe(2);
    });

    it("still answers from the assignment when the scan itself fails", async () => {
        const resolver = createPanelUpstreamResolver({
            workspaceRoot: ROOT,
            repos: () => Promise.resolve(REPOS),
            listeners: () => Promise.reject(new Error("procfs is having a day")),
            portOf: (key) => (key === "app" ? 33199 : undefined),
        });
        expect(await resolver("app")).toEqual({ state: "serving", port: 33199, assigned: true });
        expect(await resolver("idle")).toEqual({ state: "stopped" });
    });
});
