#!/usr/bin/env node
// A route a contract declares is called through a typed client, never by spelling its path: a spelled path is a second
// copy of the route that the contract cannot type, validate or rename. Discovered by shape: the contract's own
// `path: "…"` literals (read by regex, since this runs pre-install) against every literal, and every literal inside
// one, outside tests; a match fails in what is held to zero, and extension packages are held to a ratchet baseline. The
// raw routes typed in raw-json-routes.ts count as contract routes too, read off their `METHOD /path` keys.
// Two contracts, each against its callers: the sandbox contract's routes in the app, the extension seed, the site's
// samples and the extensions; the platform's ingress routes (api-contract's PLATFORM_INGRESS) in the daemon and the
// device agents, which reach them through the daemon's platform client.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";
import { codeOf, pathsIn, spelledRoutes } from "./lib/route-literals.mjs";

const CONTRACTS = `_shared/sandbox-contract/src/contracts`;
// The raw routes that answer plain JSON, each typed in the contract by its `METHOD /path` key and reached by that key
// (sandboxRaw in the app), so their paths are held like a procedure's.
const RAW_JSON = `_shared/sandbox-contract/src/protocol/raw/raw-json-routes.ts`;
const INGRESS = `_shared/api-contract/src/ingress/routes.ts`;
// The app's own route table: `/agents/:id` is a screen as well as a daemon route, and a literal it answers to is
// navigation unless its line hands it to a daemon call.
const APP_ROUTER = `_editor/web/src/router/index.ts`;

// Held to zero: the app, and what an author copies from (the extension seed, the site's code samples); each has a typed
// client. Ratcheted: the extension packages, to what the baseline allows.
const HELD = /^(_editor\/web\/src|_tools\/extension-example\/seed\/src|_site\/site\/src\/lib)\//;
const RATCHETED = /^(_extensions\/[^/]+\/src|_shared\/extension-[^/]+\/src)\//;
// Held to zero against the platform's routes: the daemon and every device agent's TypeScript.
const PLATFORM_HELD = /^(_sandbox\/sandbox\/src|_devices\/[^/]+\/src)\//;
const SOURCE = /\.(ts|mts|cts|js|mjs|vue)$/;

const rawJsonRoutes = [...readFileSync(join(root, RAW_JSON), "utf8").matchAll(/^\s*"(?:GET|POST|PUT|DELETE) (\/[^"]*)":/gm)].map((match) => match[1]);
const routes = [
    ...new Set([
        ...readdirSync(join(root, CONTRACTS))
            .filter((file) => file.endsWith(".contract.ts"))
            .flatMap((file) => pathsIn(readFileSync(join(root, CONTRACTS, file), "utf8")).filter((path) => path.startsWith("/"))),
        ...rawJsonRoutes,
    ]),
];
// Absolute, or a child of the shell's `/`; a catch-all or a param-first pattern answers to everything, so it says nothing.
const appRoutes = pathsIn(readFileSync(join(root, APP_ROUTER), "utf8"))
    .map((path) => (path.startsWith("/") ? path : `/${path}`))
    .filter((path) => path !== "/" && !path.includes("(.*)") && !path.startsWith("/:"));
const platformRoutes = [...new Set(pathsIn(readFileSync(join(root, INGRESS), "utf8")).filter((path) => path.startsWith("/")))];
if (routes.length === 0 || rawJsonRoutes.length === 0 || appRoutes.length === 0 || platformRoutes.length === 0) {
    const empty = routes.length === 0 ? CONTRACTS : rawJsonRoutes.length === 0 ? RAW_JSON : appRoutes.length === 0 ? APP_ROUTER : INGRESS;
    cannotMeasure(`contract-paths: no route paths read from ${empty}, so there is nothing to tell a route by`);
}

// A literal inside a literal counts (a code sample shipped as a string), and so does a path joined to a base
// (`${target.base}/system/session`); a site that must spell its route says why with `// allow(contract-paths): <reason>`.
const findingsOf = (path, table = { routes, appRoutes }) =>
    spelledRoutes(codeOf(path, readFileSync(join(root, path), "utf8")), table).map(({ line, route }) => ({ at: `${path}:${line}`, route }));

const subjects = subjectFiles().filter((path) => SOURCE.test(path) && !TEST_FILE.test(path));
const held = [];
const platformHeld = [];
const perFile = new Map();
for (const path of subjects) {
    if (PLATFORM_HELD.test(path)) {
        platformHeld.push(...findingsOf(path, { routes: platformRoutes, appRoutes: [] }));
    }
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
            "a contract route spelled as a path where a typed client reaches it: call it through sandboxRpc (or rpcQuery) in the app, a JSON raw route through sandboxRaw by its key, api.sandbox.rpc or api.daemon.rpc in an extension, or say at the site why the call must stay raw with `// allow(contract-paths): <reason>`",
            held.map(({ at, route }) => `${at}  spells ${route}`),
        ],
        ["an extension spelling more contract routes than its baseline allows (_tools/checks/baselines/contract-paths.json; none where there is no file)", grown],
        [
            "a platform route spelled as a path in the daemon or a device agent: call it by name through callIngress or callPlatform (the daemon's system/platform-client.ts), or say at the site why the call must stay raw with `// allow(contract-paths): <reason>`",
            platformHeld.map(({ at, route }) => `${at}  spells ${route}`),
        ],
    ],
    [
        `${routes.length} contract routes and ${platformRoutes.length} platform routes, ${subjects.length} files read: none spelled in the app, the extension seed, the site's samples, the daemon or the device agents, extensions within their baseline`,
    ],
);
