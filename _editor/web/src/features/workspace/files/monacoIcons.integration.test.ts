import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { EDITOR_ICONS, EDITOR_ICON_CSS } from "./monacoIcons";

const root = join(dirname(createRequire(import.meta.url).resolve(`monaco-editor-core/package.json`)), `esm/vs`);

it(`supplies native drawings for every icon referenced by the editor's installed modules`, () => {
    const definitions = [`codicons.js`, `codiconsLibrary.js`].map((file) => readFileSync(join(root, `base/common`, file), `utf8`)).join(`\n`);
    const ids = new Map([...definitions.matchAll(/(\w+): register\('([^']+)'/gu)].map((match) => [match[1]!, match[2]!]));
    const used = new Set<string>();
    for (const file of readdirSync(root, { recursive: true, encoding: `utf8` })) {
        if (!file.endsWith(`.js`)) {
            continue;
        }
        for (const match of readFileSync(join(root, file), `utf8`).matchAll(/Codicon\.(\w+)/gu)) {
            const id = ids.get(match[1]!);
            if (id !== undefined) {
                used.add(id);
            }
        }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((id) => id !== `blank` && !Object.hasOwn(EDITOR_ICONS, id))).toEqual([]);
});

it(`removes Monaco's font asset and supplies SVG masks for its controls`, () => {
    const css = readFileSync(join(root, `base/browser/ui/codicons/codicon/codicon.css`), `utf8`);
    expect(css).not.toContain(`@font-face`);
    expect(css).not.toContain(`codicon.ttf`);
    expect(EDITOR_ICON_CSS).toContain(`--intentic-icon-regex: url("data:image/svg+xml,`);
    expect(EDITOR_ICON_CSS).toContain(`--intentic-icon-symbol-function: url("data:image/svg+xml,`);
    expect(EDITOR_ICONS[`menu-submenu`]).toBe(`chevron-right`);
    expect(EDITOR_ICONS[`symbol-array`]).toBe(`code-array`);
});
