import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workspacePaths } from "../workspace/workspace.js";
import { discoverPanels, panelKey, panelRunDir } from "./panels.js";

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

test("panelKey maps nested ids to a DNS/tmux-safe label and rejects unsafe names", () => {
    expect(panelKey("app")).toBe("app");
    expect(panelKey("clients/foo")).toBe("clients--foo");
    // Dots and underscores can't ride a one-label subdomain or tmux session name.
    expect(panelKey("my.repo")).toBeUndefined();
    expect(panelKey("my_repo")).toBeUndefined();
});
