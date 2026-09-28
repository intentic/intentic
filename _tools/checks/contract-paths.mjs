#!/usr/bin/env node
// A route the sandbox contract declares is called through a typed client, never by spelling its path: a spelled path
// is a second copy of the route that the contract cannot type, validate or rename. Discovered by shape: the contract's
// own `path: "…"` literals (read by regex, since this runs pre-install) against every literal, and every literal inside
// one, outside tests; a match fails in what is held to zero, and extension packages are held to a ratchet baseline.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";
import { codeOf, pathsIn, spelledRoutes } from "./lib/route-literals.mjs";

const CONTRACTS = `_shared/sandbox-contract/src/contracts`;
// The app's own route table: `/agents/:id` is a screen as well as a daemon route, and a literal it answers to is
// navigation unless its line hands it to a daemon call.
const APP_ROUTER = `_editor/web/src/router/index.ts`;

// Held to zero: the app, and what an author copies from (the extension seed, the site's code samples); each has a typed
// client. Ratcheted: the extension packages, to what the baseline allows.
const HELD = /^(_editor\/web\/src|_tools\/extension-example\/seed\/src|_site\/site\/src\/lib)\//;
const RATCHETED = /^(_extensions\/[^/]+\/src|_shared\/extension-[^/]+\/src)\//;
const SOURCE = /\.(ts|mts|cts|js|mjs|vue)$/;

const routes = [
    ...new Set(
        readdirSync(join(root, CONTRACTS))
            .filter((file) => file.endsWith(".contract.ts"))
            .flatMap((file) => pathsIn(readFileSync(join(root, CONTRACTS, file), "utf8")).filter((path) => path.startsWith("/"))),
    ),
];
// Absolute, or a child of the shell's `/`; a catch-all or a param-first pattern answers to everything, so it says nothing.
const appRoutes = pathsIn(readFileSync(join(root, APP_ROUTER), "utf8"))
    .map((path) => (path.startsWith("/") ? path : `/${path}`))
    .filter((path) => path !== "/" && !path.includes("(.*)") && !path.startsWith("/:"));
if (routes.length === 0 || appRoutes.length === 0) {
    cannotMeasure(`contract-paths: no route paths read from ${routes.length === 0 ? CONTRACTS : APP_ROUTER}, so there is nothing to tell a route by`);
}

// A literal inside a literal counts (a code sample shipped as a string), and so does a path joined to a base
// (`${target.base}/system/session`); a site that must spell its route says why with `// allow(contract-paths): <reason>`.
const findingsOf = (path) =>
    spelledRoutes(codeOf(path, readFileSync(join(root, path), "utf8")), { routes, appRoutes }).map(({ line, route }) => ({ at: `${path}:${line}`, route }));

const subjects = subjectFiles().filter((path) => SOURCE.test(path) && !TEST_FILE.test(path));
const held = [];
const perFile = new Map();
for (const path of subjects) {
    if (HELD.test(path)) {
        held.push(...findingsOf(path));
    } else if (RATCHETED.test(path)) {
        const findings = findingsOf(path);
        if (findings.length > 0) {
            perFile.set(path, findings);
        }
    }
}

const { grown: over } = ratchet("contract-paths", "contract-paths", new Map([...perFile].map(([path, findings]) => [path, findings.length])));
if (ADOPTING) {
    process.exit(0);
}
const grown = over.flatMap(({ key, count, allowed }) => [
    ...perFile.get(key).map(({ at, route }) => `${at}  spells ${route}`),
    `${key}: ${count} spelled route(s), the baseline allows ${allowed}`,
]);

finish(
    [
        [
            "a contract route spelled as a path where a typed client reaches it: call it through sandboxRpc (or rpcQuery) in the app, api.sandbox.rpc or api.daemon.rpc in an extension, or say at the site why the call must stay raw with `// allow(contract-paths): <reason>`",
            held.map(({ at, route }) => `${at}  spells ${route}`),
        ],
        ["an extension spelling more contract routes than its baseline allows (_tools/checks/baselines/contract-paths.json; none where there is no file)", grown],
    ],
    [`${routes.length} contract routes, ${subjects.length} files read: none spelled in the app, the extension seed or the site's samples, extensions within their baseline`],
);
