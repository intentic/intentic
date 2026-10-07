#!/usr/bin/env node
// The turbo filters for the packages a push changed the files OF: `changed-packages.mjs <base> [head]` prints one
// `--filter=<name>` per package holding a file the range changed, space-separated, and nothing when no package's own
// files changed. `quick` (ci.yml) typechecks exactly these.
//
// NOT TURBO'S `[<base>...HEAD]`, which is what quick used to hand turbo. Turbo reads a change to a root file (the
// lockfile, the root package.json, turbo.json) as a change to every package, so a pnpm bump or a turbo.json edit made the
// job meant to answer within minutes typecheck all 97 packages, 9 to 10 minutes on a busy box (runs 37694488316 and
// 37694899281, 2026-10-07), while verify-core and verify-platform typechecked the same 97 at the same moment, each
// missing the others' cache. What a root file does to the graph is the verify groups' to measure: they typecheck every
// package of their closures on every push. This answers only what the push did to a package's own source.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { GLOBAL, ownersOf, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";

export const filtersFor = (owners) => [...owners].sort().map((name) => `--filter=${name}`);

const main = ([base, head = "HEAD"]) => {
    if (!base) {
        console.error("usage: changed-packages.mjs <base-sha> [head]");
        return 2;
    }
    const root = repoRoot(import.meta.url);
    const changed = execFileSync("git", ["diff", "--name-only", base, head], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\n")
        .filter(Boolean);
    const owners = ownersOf(readWorkspaceGraph(root), changed);
    const roots = changed.filter((path) => GLOBAL.has(path));
    if (roots.length > 0) {
        console.error(
            `changed-packages: ${roots.join(", ")} changed too; the verify groups typecheck every package for that, so this names only the packages whose own files changed`,
        );
    }
    console.error(
        owners.size === 0
            ? "changed-packages: no package's own files changed, so there is nothing to typecheck here"
            : `changed-packages: ${String(owners.size)} package${owners.size === 1 ? "" : "s"} changed: ${[...owners].sort().join(", ")}`,
    );
    console.log(filtersFor(owners).join(" "));
    return 0;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
