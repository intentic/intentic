import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES } from "@intentic/ui/text-size";

// Each pre-paint script sets the stored text size before any module loads, so it cannot import the ladder: it spells it
// out. A rung missing there paints the window at Compact and jumps a module later; a rung missing from tokens.css is a
// size nothing draws.

const read = (path: string): string => readFileSync(resolve(import.meta.dirname, path), `utf8`);
const PAGES = [`../index.html`, `../../desktop-app/local.html`, `../../desktop-app/sandbox.html`];
const painted = TEXT_SIZES.filter((size) => size !== DEFAULT_TEXT_SIZE);

describe(`the text size ladder before a module loads`, () => {
    it.each(PAGES)(`%s paints every rung but the default`, (page) => {
        const declared = /var UI_TEXT_SIZES = (\[[^\]]*\]);/u.exec(read(page))?.[1];
        expect(declared, `${page} declares no UI_TEXT_SIZES`).toEqual(expect.any(String));
        expect(JSON.parse(declared ?? `null`)).toEqual(painted);
    });

    it(`has a rule for every rung in the stylesheet`, () => {
        const tokens = read(`../../ui/src/styles/tokens.css`);
        for (const size of painted) {
            expect(tokens).toContain(`[data-text-size="${size}"]`);
        }
    });
});
