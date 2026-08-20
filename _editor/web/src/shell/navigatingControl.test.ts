/* A CONTROL THAT GOES SOMEWHERE HAS TO BE A LINK — everywhere in the app and in every extension that ships
 * with it.
 *
 * WHAT HAPPENED. Dozens of destinations were drawn as `<button @click="router.push('/sandbox')">`. On screen
 * that is indistinguishable from a link, and every one of them was reported the same way: hover it and the
 * status bar says nothing, right-click it and the browser offers no "Open link in new tab", and Ctrl/⌘-click —
 * the gesture everybody uses to keep the page they are on — moved the current tab instead of opening a second
 * one. "Sandbox settings" in the sandbox switcher was the example that started this; it was one of about thirty.
 *
 * WHY A COMPILE-LEVEL TEST. Nothing about that code is type-incorrect, lint-worthy or untested: it typechecks,
 * it lints, and a mounted test asserting "the press navigates" passes, because it does. What is missing is a
 * capability of the ELEMENT, and only reading the source shows which element was used. Reading the templates
 * directly also covers every view at once — this app's and the extensions' — with no fixture, no mocks, and
 * nothing to keep up to date as views are added.
 *
 * THE RULE IS DELIBERATELY NARROW, so it can have no allowlist. It fires on two shapes only, both of which are
 * unambiguous and both of which are how the whole class got written:
 *
 *   1. A non-anchor element whose own `@click` expression navigates.
 *   2. A handler that does NOTHING BUT navigate — a single-expression arrow — which is what such a `@click`
 *      points at once the expression is lifted out of the template.
 *
 * A handler with a body (dismiss a popover, then navigate) is not matched, because a guard cannot tell which
 * of those the click is really for. Those are links too — see <ActionLink> and ContextMenu's `url` — but the
 * judgement is a reviewer's.
 *
 * WHAT TO DO WHEN IT FIRES. Use `<RouterLink :to>`, or `<Button :as="RouterLink" :to>` where the thing is
 * shaped like a button. Where a plain click legitimately does something better than a page load — pointing the
 * docked chat at an agent rather than leaving for its page — use `<ActionLink :to @activate>`, which keeps the
 * address for the browser and gives the app only the unmodified click. In a context menu, put the address on
 * the row's `url` (see ContextMenu, and `useMenuLink`). In an extension, which has no router to reach, use
 * `appLink(api.href(path), () => api.navigate(path))`. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const ROOT = repoRoot(import.meta.url);

// This app's views, plus every extension that ships in the repo — the extensions navigate through their host
// (`api.navigate`) and had the identical class of bug, and their own packages carry no guard like this one.
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

/* Every way this codebase moves the shell FORWARD: a router push, and the two spellings of the extension
 * host's navigate (`api.navigate`, `host().navigate`).
 *
 * `router.replace` is deliberately not in it. A replace erases the entry you came from, which is the whole
 * point of it on a dead-end gate ("sign in again" after a handoff failed, "retry" after the platform was
 * unreachable) — Back must not return to the page that just refused you. A link cannot express that, so those
 * controls are correctly buttons and this rule must not claim otherwise. */
const NAVIGATES = /(?:\brouter\.push|\bnavigate)\s*\(/;

// The elements that ARE links already. `component` is the dynamic tag — a row that switches between a button
// and a RouterLink resolves at runtime, so the source cannot judge it and does not try.
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

/* Node type 1 is ELEMENT and `props` type 7 is DIRECTIVE, compared numerically so this test does not import
 * Vue's internal AST enums (deadTemplate.test.ts reads the same tree the same way). A directive's `arg` is the
 * event name for `v-on`, which is how `@click` is reported. */
const clickNavigations = (file: string, source: string): Offence[] => {
    const { descriptor, errors } = parse(source, { filename: file });
    if (errors.length > 0 || descriptor.template === null) {
        return []; // a file the compiler cannot read is a louder failure elsewhere
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

/* A handler that is nothing but a navigation: `const openThing = (): void => void router.push(...)`. Whatever
 * calls it is a control that only goes somewhere, so the control should have been the link and this indirection
 * is what hides that. Multi-statement bodies are left alone on purpose — see the header. */
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
