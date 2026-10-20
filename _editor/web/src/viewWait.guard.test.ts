import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allowedAt } from "@intentic/constants/allow";

// Refuses a view wiring its own wait. A region that is not here yet is drawn by <Await :of="loaded" imprint="…">
// (@intentic/ui, over @intentic/extension-api's `Loaded`), which owns the reveal delay, the region as it last looked,
// what that look is taken from, the failure in words and a wait that outlasts a blip. A view that wires those itself
// from `SkeletonSnapshot`, `v-skeleton-source` and `useLoadingReveal` with a loading flag of its own is how each view
// got its own wrong: a skeleton for ever (a read nobody asked for), none (a flag that was false while the read was held),
// another view's look (a name shared across subjects), a default placeholder in a grid cell, a section flashing in and
// out. Fixed one view at a time, it came back in the next. Scans the editor and the in-repo extensions; a wait that
// really is not a region's (an animation's own timing) says so with `// allow(view-wait): <why>`.

const SRC = import.meta.dirname;
const EXTENSIONS = join(SRC, `..`, `..`, `..`, `_extensions`);
const CHECK = `view-wait`;

// The chat transcript draws its turns' wait with its own row model, which is another redesign's to move; named here
// rather than allowed in place, so the list says what is left.
const EXEMPT = new Set([
    `web/features/chat/panel/pane/ChatPaneTurns.vue`,
    `web/features/chat/panel/pane/paneTranscript.ts`,
    `web/features/chat/transcript/ChatTranscriptSkeleton.vue`,
]);

const WIRING = /\b(?:SkeletonSnapshot|vSkeletonSource|useLoadingReveal|useSandboxOutline)\b|\bv-skeleton-source\b/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*|<!--)/;

const sources = (root: string, label: string): { readonly path: string; readonly text: string }[] => {
    const found: { readonly path: string; readonly text: string }[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== `node_modules` && entry.name !== `dist` && full !== join(SRC, `testing`)) {
                    walk(full);
                }
                continue;
            }
            const source =
                entry.name.endsWith(`.vue`) || (entry.name.endsWith(`.ts`) && !entry.name.endsWith(`.test.ts`) && !entry.name.endsWith(`.d.ts`));
            if (source) {
                found.push({ path: `${label}/${relative(root, full).replaceAll(`\\`, `/`)}`, text: readFileSync(full, `utf8`) });
            }
        }
    };
    walk(root);
    return found;
};

const scanned = [
    ...sources(SRC, `web`),
    ...readdirSync(EXTENSIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(EXTENSIONS, entry.name, `src`)))
        .flatMap((entry) => sources(join(EXTENSIONS, entry.name, `src`), `ext/${entry.name}`)),
];

test(`the guard is actually looking at the editor and the in-repo extensions`, () => {
    expect(scanned.filter(({ path }) => path.startsWith(`web/`)).length).toBeGreaterThanOrEqual(900);
    expect(scanned.filter(({ path }) => path.startsWith(`ext/`)).length).toBeGreaterThanOrEqual(50);
});

// A failure names a view drawing its own wait. Hand the region's read to <Await :of imprint>: a daemon read's `loaded`
// (useSandboxQuery, `api.sandbox.query`), several as `allLoaded`, a hand-rolled one through `useLoaded`.
test(`no view wires its own wait`, () => {
    const findings = scanned
        .filter(({ path }) => !EXEMPT.has(path))
        .flatMap(({ path, text }) => {
            const lines = text.split(`\n`);
            return lines.flatMap((line, at) =>
                WIRING.test(line) && !COMMENT.test(line) && !allowedAt(lines, at + 1, CHECK) ? [`${path}:${at + 1}: ${line.trim()}`] : [],
            );
        });
    expect(findings).toEqual([]);
});
