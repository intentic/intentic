#!/usr/bin/env node
// EVERY READ OF ONE SANDBOX SAYS WHICH. The editor was written for one active sandbox per window, and a file that reads
// `activeSandboxId`, calls `sandboxRpc` with no `at` or reads `rpcQuery` with no `at` speaks of whichever sandbox is
// active, wherever it is drawn: inside a Home tile for another sandbox it reads the wrong one. A component that speaks
// of the sandbox it stands in takes `useSandboxScope()` (`_editor/web/src/client/sandbox/scope/useSandboxScope.ts`) and
// reads through `scope.rpc`, `scope.query` and `scope.key`, or passes `at` itself.
//
// Held in the editor above the client: the client layer is where the active sandbox is defined and its doors are built,
// and composition (the shell, the router, the host) is what chooses it. A site that must read the active sandbox
// whatever it stands in (a switch, a header naming where the window is) says why with `// allow(sandbox-scope): <reason>`.
// Each file's standing count, from when the scope landed, is held in baselines/sandbox-scope.json and may only shrink.
//
// `--allow <file>[,<file>…] --reason "<why>"` records a file at what it holds now (lib/ratchet.mjs `allowOne`), from any
// checkout, so the entry rides the change that needs it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EDITOR_LAYERS } from "./lib/editor-layers.mjs";
import { sandboxScopeCalls } from "./lib/sandbox-scope-calls.mjs";
import { ADOPTING, allowOne, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";

const SRC = `_editor/web/src/`;
const SOURCE = /\.(?:ts|vue)$/;
const DECLARATIONS = /\.d\.ts$/;
// Where the active sandbox is defined and chosen: read freely there.
const EXEMPT_LAYERS = new Set([`client`, `composition`]);
const layerOfUnit = new Map(EDITOR_LAYERS.flatMap(({ name, units }) => units.map((unit) => [unit, name])));

// The layer a source file sits in, by its first directory under src/; a root file (main.ts, App.vue) is composition.
const layerOf = (path) => {
    const rest = path.slice(SRC.length);
    return rest.includes(`/`) ? layerOfUnit.get(rest.slice(0, rest.indexOf(`/`))) : `composition`;
};

const subjects = subjectFiles(`${SRC}**`).filter(
    (path) => path.startsWith(SRC) && SOURCE.test(path) && !DECLARATIONS.test(path) && !TEST_FILE.test(path) && !EXEMPT_LAYERS.has(layerOf(path)),
);
const found = new Map();
const sites = new Map();
for (const path of subjects) {
    const here = sandboxScopeCalls(readFileSync(join(root, path), `utf8`));
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

const allowAt = process.argv.indexOf(`--allow`);
if (allowAt !== -1) {
    const keys = (process.argv[allowAt + 1] ?? ``).split(`,`).filter((key) => key !== `` && !key.startsWith(`--`));
    if (keys.length === 0) {
        console.error(`sandbox-scope: --allow needs the file to record, e.g. --allow ${[...found.keys()][0] ?? `${SRC}features/x/y.ts`}`);
        process.exit(2);
    }
    const none = keys.filter((key) => !found.has(key));
    if (none.length > 0) {
        console.error(`sandbox-scope: ${none.join(`, `)} read(s) no sandbox unaimed, so there is nothing to record`);
        process.exit(2);
    }
    for (const key of keys) {
        allowOne(`sandbox-scope`, `sandbox-scope`, key, found.get(key));
    }
    console.log(`sandbox-scope: recorded ${keys.length} file(s) with its reason. The entry rides the change that needs it, and a change that shrinks one lowers it again (--tighten)`);
    process.exit(0);
}

const { grown } = ratchet(`sandbox-scope`, `sandbox-scope`, found);
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
    `${key}: ${count} read(s) of the active sandbox that name none, the baseline allows ${allowed}`,
]);

finish(
    [
        [
            `the active sandbox read where nothing says which: take useSandboxScope() and read through scope.rpc, scope.query and scope.key (or pass \`at\`), or say at the site why it must read the active one with \`// allow(sandbox-scope): <reason>\``,
            problems,
        ],
    ],
    [`${subjects.length} editor files read: no new read of the active sandbox that names none`],
);
