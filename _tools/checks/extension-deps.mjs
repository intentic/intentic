#!/usr/bin/env node
// An extension's manifest names only the @intentic/* packages its imports may reach (lib/extension-deps.mjs, the same
// list as the `_extensions/**` no-restricted-imports override in .oxlintrc.json): a dependency the linter would refuse
// to import is a coupling waiting for its first import, and one a published extension would install beside it. And the
// other way round: outside _extensions only the packages CONSUMERS names may depend on an extension, each only through
// the specifiers it lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, BUILD_ONLY, CONSUMERS, consumerFindings, manifestFindings, SHIPPED, specifierFindings } from "./lib/extension-deps.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";
import { readWorkspaceGraph } from "./lib/workspace-graph.mjs";

// Only the manifests pnpm links as members: a fixture's or a seed's package.json installs nothing.
const graph = readWorkspaceGraph(root);
const members = new Set([...graph.packages.values()].map(({ dir }) => `${dir}/package.json`));
const subjects = subjectFiles("_extensions/*/package.json").filter((path) => members.has(path));

const findings = subjects.flatMap((path) => manifestFindings(path, readFileSync(join(root, path), "utf8")));

const outside = [...members].filter((path) => !path.startsWith("_extensions/") && subjectFiles(path).length > 0);
const consumers = outside.flatMap((path) => consumerFindings(path, readFileSync(join(root, path), "utf8")));
const CODE = /\.(ts|mts|js|mjs|vue)$/;
const reaches = [...CONSUMERS].flatMap(([dir, { specifiers }]) =>
    specifiers === undefined
        ? []
        : subjectFiles(`${dir}/*`)
              .filter((path) => CODE.test(path) && !path.includes("/node_modules/") && !path.includes("/dist/"))
              .flatMap((path) => specifierFindings(path, readFileSync(join(root, path), "utf8"), specifiers)),
);
const shippedFields = Object.keys(ALLOWED).filter((field) => field !== "devDependencies");

finish(
    [
        [
            `An extension depends on an @intentic/* package outside the extension SDK (_extensions/README.md): ${shippedFields.join(", ")} may name ${SHIPPED.join(", ")}; devDependencies may add ${BUILD_ONLY.join(", ")}. Reach the rest through the SDK, or move what is needed into one of those packages`,
            findings,
        ],
        [
            `A package outside _extensions depends on an extension it may not (lib/extension-deps.mjs CONSUMERS): an extension stands on the SDK and nothing stands on it, apart from the web app's bundle and the files sidecar's one entry. Move what both need into the SDK or sandbox-contract, or, if this package really hosts the extension, add it to CONSUMERS with its reason`,
            consumers,
        ],
        [
            `A host of an extension imports it past the entry it is allowed (lib/extension-deps.mjs CONSUMERS): reach the extension through that entry, or export what is needed from it`,
            reaches,
        ],
    ],
    [
        `extension-deps: ${subjects.length} extension manifests read, each names only the @intentic/* packages the extension SDK allows`,
        `extension-deps: ${outside.length} other manifests read, only ${[...CONSUMERS.keys()].join(" and ")} name an extension, each through what CONSUMERS allows`,
    ],
);
