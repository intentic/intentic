#!/usr/bin/env node
// ONE DOOR TO THE DAEMON'S PLAIN-JSON ROUTES, AND IT IS `sandboxRaw`. A daemon path spelled to `sandboxJson` or
// `sandboxRequest` is a second copy of the route that the contract cannot type, parse, rename or protect: fourteen of
// them were a bare `<T>` cast of whatever came back, six parsed it with a schema written beside the call, and one list
// had two schemas for the same answer. `sandboxRaw(key)` (`_editor/web/src/client/sandbox/sandboxRaw.ts`) takes the
// path, the body and the answer's schema from `RAW_JSON_ROUTES`, one entry per route (`_shared/sandbox-contract`).
//
// Held in the editor outside the client's own door (`client/sandbox/`): a path spelled as a string literal to the
// bare client, and a fetch of a `rawRouteUrl` path, which goes around the client's session and drift handling. A site that
// must stay says why with `// allow(daemon-doors): <reason>`: the three that reach a daemon the page has no session on yet
// are the standing ones. A new finding fails; a standing one is held in baselines/daemon-doors.json, which may only shrink.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonDoorCalls } from "./lib/daemon-door-calls.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";

const EDITOR = /^_editor\/web\/src\//;
// The door's own folder is where the bare client is defined and wrapped; tests and fixtures stand code up by hand.
const DOORS = /^_editor\/web\/src\/client\/sandbox\//;
const SOURCE = /\.(?:ts|mts|vue)$/;
const FIXTURE = /\/(?:testing|fixtures?)\/|\.testing\.ts$|\/testing\.ts$/;

const subjects = subjectFiles().filter((path) => EDITOR.test(path) && !DOORS.test(path) && SOURCE.test(path) && !TEST_FILE.test(path) && !FIXTURE.test(path));
const found = new Map();
const sites = new Map();
for (const path of subjects) {
    const here = daemonDoorCalls(readFileSync(join(root, path), `utf8`));
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

const { grown } = ratchet(`daemon-doors`, `daemon-doors`, found);
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
    `${key}: ${count} reach(es) around sandboxRaw, the baseline allows ${allowed}`,
]);

finish(
    [[`the daemon reached around its one JSON door: call a plain-JSON route through sandboxRaw by its key (add it to RAW_JSON_ROUTES), or say at the site why it must stay raw with \`// allow(daemon-doors): <reason>\``, problems]],
    [`${subjects.length} editor files read: no daemon path spelled to sandboxJson or sandboxRequest, no fetch of a rawRouteUrl path outside what says why`],
);
