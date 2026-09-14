import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { contentEntries, isTechnical, kindOf, summaryOf } from "./contentFiles.js";

const file = (name: string, over: Partial<WorkspaceTreeEntry> = {}): WorkspaceTreeEntry => ({ name, path: name, type: `file`, ...over });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir` });

describe(`what a project's Files shows`, () => {
    it(`keeps documents, media, pages and source, and drops tooling, tests and dot entries`, () => {
        const shown = contentEntries([
            file(`package.json`),
            file(`notes.md`),
            dir(`node_modules`),
            dir(`docs`),
            file(`hero.png`),
            file(`.gitignore`),
            file(`app.test.ts`),
            file(`index.html`),
            file(`vite.config.ts`),
            file(`ignored.log`, { ignored: true }),
        ]).map((entry) => entry.name);
        expect(shown).toEqual([`docs`, `hero.png`, `index.html`, `notes.md`]);
    });

    it(`names a file's kind by extension, with a document as the fallback`, () => {
        expect(kindOf(dir(`docs`))).toBe(`folder`);
        expect(kindOf(file(`hero.png`))).toBe(`image`);
        expect(kindOf(file(`talk.mp3`))).toBe(`media`);
        expect(kindOf(file(`budget.xlsx`))).toBe(`sheet`);
        expect(kindOf(file(`index.html`))).toBe(`page`);
        expect(kindOf(file(`main.ts`))).toBe(`code`);
        expect(kindOf(file(`letter`))).toBe(`document`);
    });

    it(`treats an ignored entry as technical whatever its name`, () => {
        expect(isTechnical(file(`notes.md`, { ignored: true }))).toBe(true);
    });
});

describe(`a project's one-line summary`, () => {
    it(`is the first paragraph of the README that is not a heading or a badge`, () => {
        expect(summaryOf(`# Shop\n\n[![ci](x)](y)\n\nA one page site for the bakery,\nwith the menu.\n\nMore below.`)).toBe(
            `A one page site for the bakery, with the menu.`,
        );
    });

    it(`is empty for a README with nothing but headings`, () => {
        expect(summaryOf(`# Shop\n\n## Setup\n`)).toBe(``);
    });
});
