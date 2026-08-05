import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ListeningPort } from "../ports/port-scan.js";
import { workspacePaths } from "../workspace/workspace.js";
import { discoverPanels, listenerDir, listenersByRepo, oneServerPerDir, panelKey, panelRunDir } from "./panels.js";

// A temp workspace: every repo is a dir with a .git (role and clone alike — discovery is .git-based). A repo
// has a panel when a `dev` script lives at its operator/ (devScript) OR its root (rootDev).
const setup = (repos: { name: string; devScript?: boolean; operatorNoDev?: boolean; rootDev?: boolean }[]) => {
    const root = mkdtempSync(join(tmpdir(), "discover-"));
    for (const repo of repos) {
        const dir = join(root, repo.name);
        mkdirSync(join(dir, ".git"), { recursive: true });
        if (repo.rootDev === true) {
            writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
        }
        if (repo.devScript === true || repo.operatorNoDev === true) {
            mkdirSync(join(dir, "operator"), { recursive: true });
            writeFileSync(
                join(dir, "operator", "package.json"),
                JSON.stringify(repo.devScript === true ? { scripts: { dev: "vite" } } : { scripts: {} }),
            );
        }
    }
    return workspacePaths(root);
};

test("discovers role repos + extra clones, sorted, with hasPanel from operator/", async () => {
    const workspace = setup([
        { name: "intent" },
        { name: "desired-state", devScript: true },
        { name: "app", operatorNoDev: true },
        { name: "acme", devScript: true },
    ]);
    expect(await discoverPanels(workspace)).toEqual([
        { repo: "acme", hasPanel: true },
        { repo: "app", hasPanel: false }, // operator/ present but no `dev` script ⇒ not a runnable panel
        { repo: "desired-state", hasPanel: true },
        { repo: "intent", hasPanel: false },
    ]);
});

test("an empty workspace discovers nothing", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "empty-")));
    expect(await discoverPanels(workspace)).toEqual([]);
});

test("a non-.git directory alongside repos is not a repo, but a nested repo inside it is", async () => {
    const workspace = setup([{ name: "app", devScript: true }]);
    // A stray dir with no .git isn't a repo itself…
    mkdirSync(join(workspace.root, "scratch"), { recursive: true });
    // …but a repo cloned inside it is discovered under its nested id.
    mkdirSync(join(workspace.root, "scratch", "notes", ".git"), { recursive: true });
    expect(await discoverPanels(workspace)).toEqual([
        { repo: "app", hasPanel: true },
        { repo: "scratch/notes", hasPanel: false },
    ]);
});

test("a repo is a panel when its ROOT has a dev script (a scaffolded app is its own panel)", async () => {
    const workspace = setup([
        { name: "shop", rootDev: true }, // app repo: root dev, no operator/
        { name: "notes" }, // a repo with neither ⇒ no panel
    ]);
    expect(await discoverPanels(workspace)).toEqual([
        { repo: "notes", hasPanel: false },
        { repo: "shop", hasPanel: true },
    ]);
    // Root is the run dir when there's no operator/.
    expect(await panelRunDir(workspace, "shop")).toBe(join(workspace.root, "shop"));
    expect(await panelRunDir(workspace, "notes")).toBeUndefined();
});

test("operator/ is preferred over the repo root when both are runnable", async () => {
    const workspace = setup([{ name: "app", devScript: true, rootDev: true }]);
    expect(await panelRunDir(workspace, "app")).toBe(join(workspace.root, "app", "operator"));
});

// A procfs listener as the scan reports it — only the fields the attribution reads.
const listener = (port: number, cwd?: string, forwardable = true): ListeningPort => ({
    port,
    host: "127.0.0.1",
    forwardable,
    ...(cwd === undefined ? {} : { cwd }),
});

test("a repo claims the listeners bound from inside it — one per app for a monorepo's fan-out", () => {
    const root = "/work";
    const found = listenersByRepo(
        [
            listener(47145, "/work/intentic/_apps/web"),
            listener(6480, "/work/intentic/_apps/api"),
            listener(4321, "/work/intentic/_apps/site"),
            listener(3000, "/work/shop"),
        ],
        root,
        ["intentic", "shop"],
    );
    expect(found.get("intentic")?.map((entry) => entry.port)).toEqual([47145, 6480, 4321]);
    expect(found.get("shop")?.map((entry) => entry.port)).toEqual([3000]);
});

test("listeners nobody can claim are dropped: no cwd, a cwd outside the workspace, an unforwardable bind", () => {
    const found = listenersByRepo(
        [
            listener(8787), // the daemon's own socket — procfs gave up no cwd
            listener(5432, "/var/lib/postgresql"), // outside the workspace entirely
            listener(53, "/work/intentic", false), // a loopback alias only answering at its own address
        ],
        "/work",
        ["intentic"],
    );
    expect(found.size).toBe(0);
});

test("a repo cloned inside another keeps its own listeners — the longest matching dir wins", () => {
    const found = listenersByRepo([listener(3000, "/work/intentic/vendor/widget/src")], "/work", ["intentic", "intentic/vendor/widget"]);
    expect(found.get("intentic")).toBeUndefined();
    expect(found.get("intentic/vendor/widget")?.map((entry) => entry.port)).toEqual([3000]);
});

test("a listener is named by the package that bound it; one at the repo root has no name to give", () => {
    expect(listenerDir(listener(47145, "/work/intentic/_apps/web"), "/work", "intentic")).toBe("_apps/web");
    expect(listenerDir(listener(3000, "/work/shop"), "/work", "shop")).toBeUndefined();
    expect(listenerDir(listener(8787), "/work", "shop")).toBeUndefined();
});

/* Measured against the real thing: two apps under one `pnpm dev` answered on FIVE ports, because Vite's HMR
 * channel and dependency optimizer bind from the same directory as the app they serve. */
test("a package's sidecar sockets collapse into the one server the app is on", () => {
    expect(
        oneServerPerDir([
            { url: `http://localhost:4321`, dir: `_apps/site` },
            { url: `https://localhost:47145`, dir: `_apps/web` },
            { url: `http://localhost:47146`, dir: `_apps/demo` },
            { url: `http://localhost:47180`, dir: `_apps/demo` }, // the demo's own sidecar
            { url: `http://localhost:47199`, dir: `_apps/web` }, // vite's HMR channel
        ]),
    ).toEqual([
        { url: `http://localhost:4321`, dir: `_apps/site` },
        { url: `https://localhost:47145`, dir: `_apps/web` },
        { url: `http://localhost:47146`, dir: `_apps/demo` },
    ]);
});

test("servers at the repo root share one slot too — a scaffolded app is its own package", () => {
    expect(oneServerPerDir<{ url: string; dir?: string }>([{ url: `http://localhost:3000` }, { url: `http://localhost:3001` }])).toEqual([{ url: `http://localhost:3000` }]);
});

test("panelKey maps nested ids to a DNS/tmux-safe label and rejects unsafe names", () => {
    expect(panelKey("app")).toBe("app");
    expect(panelKey("clients/foo")).toBe("clients--foo");
    // Dots and underscores can't ride a one-label subdomain or tmux session name.
    expect(panelKey("my.repo")).toBeUndefined();
    expect(panelKey("my_repo")).toBeUndefined();
});
