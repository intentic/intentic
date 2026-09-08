// Pins that a clickable control which navigates is drawn as a real link (RouterLink, ActionLink, or a context-menu
// url), across this app and every extension, so hover, right-click and Ctrl/Cmd-click behave correctly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const ROOT = repoRoot(import.meta.url);

// This app's views plus every extension's src; extensions have no guard of their own for this bug class.
const ROOTS = [
    join(ROOT, `_editor/web/src`),
    join(ROOT, `_editor/ui/src`),
    ...readdirSync(join(ROOT, `_extensions`), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(ROOT, `_extensions`, entry.name, `src`))
        .filter((path) => existsDir(path)),
];

function existsDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

// router.replace is excluded: erasing the back entry is right for a dead-end retry, which a link can't express.
const NAVIGATES = /(?:\brouter\.push|\bnavigate)\s*\(/;

// Elements already treated as links; `component` is a dynamic tag the source can't judge, so it's skipped.
const LINKS = new Set([`a`, `RouterLink`, `router-link`, `ActionLink`, `component`]);

const vueFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            return vueFiles(path);
        }
        return entry.endsWith(`.vue`) ? [path] : [];
    });

interface Offence {
    readonly file: string;
    readonly line: number;
    readonly what: string;
}

// Node type 1 is ELEMENT, prop type 7 is DIRECTIVE, compared numerically to avoid importing Vue's AST enums. A
// directive's `arg` gives the event name for `v-on`, e.g. `@click`.
const clickNavigations = (file: string, source: string): Offence[] => {
    const { descriptor, errors } = parse(source, { filename: file });
    if (errors.length > 0 || descriptor.template === null) {
        return []; // A file the compiler cannot read fails louder elsewhere.
    }
    const found: Offence[] = [];
    const walk = (node: { type: number; tag?: string; props?: unknown[]; children?: unknown[]; loc?: { start: { line: number } } }): void => {
        if (node.type === 1 && node.tag !== undefined && !LINKS.has(node.tag)) {
            for (const prop of (node.props ?? []) as { type: number; name?: string; arg?: { content?: string }; exp?: { content?: string } }[]) {
                const expression = prop.exp?.content ?? ``;
                if (prop.type === 7 && prop.name === `on` && prop.arg?.content === `click` && NAVIGATES.test(expression)) {
                    found.push({ file, line: node.loc?.start.line ?? 0, what: `<${node.tag}> navigates on click: ${expression.trim()}` });
                }
            }
        }
        for (const child of (node.children ?? []) as Parameters<typeof walk>[0][]) {
            walk(child);
        }
    };
    for (const child of descriptor.template.ast?.children ?? []) {
        walk(child as Parameters<typeof walk>[0]);
    }
    return found;
};

// A handler that does nothing but navigate; a multi-statement body is left alone (a reviewer's call).
const PURE_NAVIGATOR =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::\s*[^=]+?)?=>\s*(?:void\s+)?(?:router\.push|api\.navigate|host\(\)\.navigate)\s*\(/g;

const pureNavigators = (file: string, source: string): Offence[] =>
    [...source.matchAll(PURE_NAVIGATOR)].map((match) => ({
        file,
        line: source.slice(0, match.index).split(`\n`).length,
        what: `\`${match[1]}\` only navigates — whatever calls it should be a link instead`,
    }));

it(`draws every control that goes somewhere as a link`, () => {
    const offences = ROOTS.flatMap(vueFiles).flatMap((file) => {
        const source = readFileSync(file, `utf8`);
        return clickNavigations(file, source).concat(pureNavigators(file, source));
    });

    expect(offences.map((offence) => `${offence.file.slice(ROOT.length + 1)}:${offence.line} — ${offence.what}`)).toEqual([]);
});
