#!/usr/bin/env node
// ONE FORMATTER PER CONCEPT, AND IT IS THE KIT'S. Every number and date a reader sees goes through the UI kit's
// format.ts (`@intentic/ui/format`; `@intentic/extension-ui/format` in an extension): relative time, a span of time,
// money, a count exact or compact, bytes, a percentage, a date. Each follows the language the app is in and re-renders
// when it changes, and each has one rounding rule. A hand-made formatter is how the editor came to say "2h" in a chat
// tab and "1h ago" in the Inbox for the same 90 minutes, and English in a Polish window.
//
// Refused in the editor's surfaces (the web app, the desktop shell, the share view) and every extension, outside tests:
//   1. `.toLocaleString(` / `.toLocaleDateString(` / `.toLocaleTimeString(`: the browser's language, not the app's.
//   2. `new Intl.NumberFormat(` / `new Intl.DateTimeFormat(` / `Intl.RelativeTimeFormat`: a formatter frozen where built.
//   3. `sizeLabel` / `briefDuration` imported from `@intentic/base`: fixed English labels meant for the daemon and CLIs.
//
// A site that is right to do it (a machine format, a prompt for an agent, a zone's offset) says why with
// `// allow(format-tiers): <reason>`. What could not be moved yet is counted per file in baselines/format-tiers.json,
// which may only shrink. time-zones.mjs keeps its own date rule for the rest of the repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatCalls } from "./lib/format-calls.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";

const SURFACES = /^(?:_editor\/(?:web|desktop-app|share-view)\/src|_extensions\/[^/]+\/src)\//;
const SOURCE = /\.(?:ts|mts|tsx|js|mjs|vue)$/;
const FIXTURE = /\/(?:testing|fixtures?)\/|\.testing\.ts$|\/testing\.ts$/;

const subjects = subjectFiles().filter((path) => SURFACES.test(path) && SOURCE.test(path) && !TEST_FILE.test(path) && !FIXTURE.test(path));
const perFile = new Map();
for (const path of subjects) {
    const found = formatCalls(readFileSync(join(root, path), `utf8`));
    if (found.length > 0) {
        perFile.set(path, found);
    }
}

const { grown } = ratchet(`format-tiers`, `format-tiers`, new Map([...perFile].map(([path, found]) => [path, found.length])));
if (ADOPTING) {
    process.exit(0);
}

finish(
    [
        [
            `a number or a date formatted by hand where the reader's language should say it: use the kit's formatter (@intentic/ui/format, or @intentic/extension-ui/format in an extension: formatCount, formatCompact, formatMoney, formatElapsed, formatBytes, formatPercent, timeAgo, formatDate…), or say at the site why it must stay with \`// allow(format-tiers): <reason>\``,
            grown.flatMap(({ key, count, allowed }) => [
                ...perFile.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
                ...(allowed > 0 ? [`${key}: ${count} by hand, the baseline (_tools/checks/baselines/format-tiers.json) allows ${allowed}`] : []),
            ]),
        ],
    ],
    [`${subjects.length} files in the editor's surfaces and the extensions: every number and date formats through the kit`],
);
