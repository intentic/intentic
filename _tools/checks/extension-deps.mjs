#!/usr/bin/env node
// An extension's manifest names only the @intentic/* packages its imports may reach (lib/extension-deps.mjs, the same
// list as the `_extensions/**` no-restricted-imports override in .oxlintrc.json): a dependency the linter would refuse
// to import is a coupling waiting for its first import, and one a published extension would install beside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, BUILD_ONLY, manifestFindings, SHIPPED } from "./lib/extension-deps.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";
import { readWorkspaceGraph } from "./lib/workspace-graph.mjs";

// Only the manifests pnpm links as members: a fixture's or a seed's package.json installs nothing.
const graph = readWorkspaceGraph(root);
const members = new Set([...graph.packages.values()].map(({ dir }) => `${dir}/package.json`));
const subjects = subjectFiles("_extensions/*/package.json").filter((path) => members.has(path));

const findings = subjects.flatMap((path) => manifestFindings(path, readFileSync(join(root, path), "utf8")));
const shippedFields = Object.keys(ALLOWED).filter((field) => field !== "devDependencies");

finish(
    [
        [
            `An extension depends on an @intentic/* package outside the extension SDK (_extensions/README.md): ${shippedFields.join(", ")} may name ${SHIPPED.join(", ")}; devDependencies may add ${BUILD_ONLY.join(", ")}. Reach the rest through the SDK, or move what is needed into one of those packages`,
            findings,
        ],
    ],
    [`extension-deps: ${subjects.length} extension manifests read, each names only the @intentic/* packages the extension SDK allows`],
);
