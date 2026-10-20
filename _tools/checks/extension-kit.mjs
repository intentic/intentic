#!/usr/bin/env node
// Every extension this workspace builds, in this repository (_extensions/* and the example seed) and beside it (the standalone checkouts under
// the workspace's extensions/, each its own repository), is judged by the kit's own published checker
// (_shared/extension-ui/check/extension.mjs, `intentic-kit-check` in each extension's typecheck) against the kit and API
// as they stand in this tree: no deprecated kit name imported, no retired prop or recipe member used, the kit's decided
// looks kept, and an `engines.intentic` floor that has every name the extension imports. A kit change that deprecates
// something the workspace's own shipped extensions still use fails here, rather than in an extension repository nobody
// reopened. A finding that is right to keep says so in place: `allow(kit-check): <reason>`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { extensionFindings } from "../../_shared/extension-ui/check/extension.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const SOURCE = /\.(?:vue|ts|mts|js|mjs)$/u;
const SKIPPED = /\.(?:test|spec)\.\w+$|\.d\.m?ts$/u;
const surface = JSON.parse(readFileSync(join(root, `_shared/extension-api/src/surface.json`), `utf8`));

// In this repository: the tracked sources git lists. Beside it: every source file on disk, since each is another repo.
const tracked = (dir) =>
    subjectFiles(`${dir}/src`)
        .filter((path) => SOURCE.test(path) && !SKIPPED.test(path))
        .map((path) => ({ path: path.slice(dir.length + 1), text: readFileSync(join(root, path), `utf8`) }));
const onDisk = (dir) => {
    const files = [];
    const walk = (at) => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const full = join(at, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== `node_modules` && entry.name !== `dist` && !entry.name.startsWith(`.`)) {
                    walk(full);
                }
            } else if (SOURCE.test(entry.name) && !SKIPPED.test(entry.name)) {
                files.push({ path: relative(dir, full).replaceAll(`\\`, `/`), text: readFileSync(full, `utf8`) });
            }
        }
    };
    walk(join(dir, `src`));
    return files;
};

const extensionsIn = (base) =>
    existsSync(base)
        ? readdirSync(base, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, `intentic-extension.json`)) && existsSync(join(base, entry.name, `src`)))
              .map((entry) => join(base, entry.name))
        : [];

// The seed authors copy (_tools/extension-example) is judged with the in-repo ones: what it teaches is what they ship.
const SEED = join(root, `_tools/extension-example/seed`);
const judged = [
    ...[...extensionsIn(join(root, `_extensions`)), SEED].map((dir) => ({ label: relative(root, dir), dir, files: tracked(relative(root, dir)) })),
    ...extensionsIn(join(root, `..`, `extensions`)).map((dir) => ({ label: `../extensions/${relative(join(root, `..`, `extensions`), dir)}`, dir, files: onDisk(dir) })),
];

const findings = judged.flatMap(({ label, dir, files }) =>
    extensionFindings({ files, manifest: JSON.parse(readFileSync(join(dir, `intentic-extension.json`), `utf8`)), surface }).map(
        ({ at, why }) => `${label}/${at}  ${why}`,
    ),
);

finish(
    [[`An extension takes from the kit what the kit no longer decides it may, or imports past its engines.intentic floor (names.mjs in _shared/extension-ui says what replaced what)`, findings]],
    [`extension-kit: ${judged.length} extensions read (${judged.filter(({ label }) => label.startsWith(`../`)).length} beside this repository), each on the kit as it stands and within its engines floor`],
);
