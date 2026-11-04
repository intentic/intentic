#!/usr/bin/env node
// An address of the app is built, never typed: `_shared/sandbox-contract/src/app-routes` names every page once
// (app-pages.ts), says where each is drawn (paths.ts: inside a sandbox at `/s/<sandbox>/…`, in Home's frame at
// `/home/…`) and what the addresses from before frames meant (legacy.ts), and every link is made by its builders
// (`page.*`, `insidePath`, `homePath`, `topPath`, or the editor's wrappers in lib/routes/links.ts). A path typed by hand
// is a second copy of a page's address that a rename or a move of frame leaves pointing at nothing, and no type error
// says so. So a string literal fails here when it opens with `/<root>` and then its end, `/`, `?`, `#` or a `${`, where a
// root is the first static segment of any page, old address or frame. The roots are read off those files as text, since
// the checks run before `pnpm install`, so a new page joins the rule by being written there.
// Read: the editor, the desktop app, every extension, the demo and the daemon's push messages, in .ts, .mts and .vue (a
// component's script, its `to` and `href` attributes, and the code of its bindings). Not read: the app-routes tables,
// tests, fixtures and `testing.ts`, and comments. Not a finding: a literal handed to the daemon on its line (its own
// routes share these prefixes), a user's home directory (`/home/ada/…`), or a site that says why with
// `// allow(route-literal): <reason>` on its line or the line above. How each is told is lib/app-route-literals.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";
import { isSubject, PRAGMA, routeLiterals, routeRoots } from "./lib/app-route-literals.mjs";

const APP_ROUTES = "_shared/sandbox-contract/src/app-routes";
// Fewer roots than this is a table the parse no longer reads, not a smaller app: it has well over twenty today.
const FEWEST_ROOTS = 10;

const read = (file) => {
    try {
        return readFileSync(join(root, APP_ROUTES, file), "utf8");
    } catch (error) {
        return cannotMeasure(
            `route-literals: ${APP_ROUTES}/${file} could not be read (${error.code ?? error.message}), so there is nothing to tell an address by`,
        );
    }
};
const { roots, missing } = routeRoots({ pages: read("app-pages.ts"), legacy: read("legacy.ts"), paths: read("paths.ts") });
if (missing.length > 0 || roots.length < FEWEST_ROOTS) {
    cannotMeasure(
        `route-literals: read ${roots.length} route roots from ${APP_ROUTES}${missing.length > 0 ? `, and no ${missing.join(", ")}` : ""}; a table moved or changed shape, so the rule would judge too little`,
    );
}

const subjects = subjectFiles().filter(isSubject);
const findings = subjects.flatMap((path) =>
    routeLiterals(path, readFileSync(join(root, path), "utf8"), roots).map(
        ({ line, literal }) => `${path}:${line}: ${literal} — build it with the app-routes builders (lib/routes/links.ts in the editor)`,
    ),
);

finish(
    [
        [
            `an app address typed by hand: build it from ${APP_ROUTES} (page.*, insidePath, homePath, topPath, localPath; the editor's lib/routes/links.ts), or say at the site why it must stay with \`// allow(${PRAGMA}): <reason>\``,
            findings,
        ],
    ],
    [`${roots.length} route roots, ${subjects.length} files read: no app address typed by hand`],
);
