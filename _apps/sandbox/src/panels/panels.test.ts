import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workspacePaths } from "../workspace/workspace.js";
import { discoverPanels, panelRunDir } from "./panels.js";

// A temp workspace: role dirs (intent/desired-state/app) and extra clones (.git) both surface. A repo has a
// panel when a `dev` script lives at its operator/ (devScript) OR its root (rootDev).
const setup = (repos: { name: string; extra?: boolean; devScript?: boolean; operatorNoDev?: boolean; rootDev?: boolean }[]) => {
    const root = mkdtempSync(join(tmpdir(), "discover-"));
    for (const repo of repos) {
        const dir = join(root, "repositories", repo.name);
        mkdirSync(dir, { recursive: true });
        if (repo.extra === true) {
            mkdirSync(join(dir, ".git"), { recursive: true });
        }
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
        { name: "acme", extra: true, devScript: true },
    ]);
    expect(await discoverPanels(workspace)).toEqual([
        { repo: "acme", hasPanel: true },
        { repo: "app", hasPanel: false }, // operator/ present but no `dev` script ⇒ not a runnable panel
        { repo: "desired-state", hasPanel: true },
        { repo: "intent", hasPanel: false },
    ]);
});

test("an empty workspace (no repositories dir) discovers nothing", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "empty-")));
    expect(await discoverPanels(workspace)).toEqual([]);
});

test("a non-.git directory alongside repos is not a repo", async () => {
    const workspace = setup([{ name: "app", devScript: true }]);
    // A stray dir with no .git and not a role name is ignored by listRepos.
    mkdirSync(join(workspace.repositories, "scratch"), { recursive: true });
    expect(await discoverPanels(workspace)).toEqual([{ repo: "app", hasPanel: true }]);
});

test("a repo is a panel when its ROOT has a dev script (a scaffolded app is its own panel)", async () => {
    const workspace = setup([
        { name: "shop", extra: true, rootDev: true }, // app repo: root dev, no operator/
        { name: "notes", extra: true }, // a repo with neither ⇒ no panel
    ]);
    expect(await discoverPanels(workspace)).toEqual([
        { repo: "notes", hasPanel: false },
        { repo: "shop", hasPanel: true },
    ]);
    // Root is the run dir when there's no operator/.
    expect(await panelRunDir(workspace, "shop")).toBe(join(workspace.repositories, "shop"));
    expect(await panelRunDir(workspace, "notes")).toBeUndefined();
});

test("operator/ is preferred over the repo root when both are runnable", async () => {
    const workspace = setup([{ name: "app", extra: true, devScript: true, rootDev: true }]);
    expect(await panelRunDir(workspace, "app")).toBe(join(workspace.repositories, "app", "operator"));
});
