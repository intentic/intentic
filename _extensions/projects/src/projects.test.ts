import { describe, expect, it } from "vitest";
import { freeProjectName, previewPath, projectIds, projectPath, slugOf, summaryOf } from "./projects.js";

describe(`which repositories are projects`, () => {
    it(`lists every repository but the workspace's own, in name order`, () => {
        expect(projectIds([`shop`, `root`, `blog`, `tools/cli`])).toEqual([`blog`, `shop`, `tools/cli`]);
        expect(projectIds([`root`])).toEqual([]);
    });
});

describe(`a tile's summary`, () => {
    it(`is the README's first paragraph that is not a heading or a badge`, () => {
        expect(summaryOf(`# Shop\n\n[![ci](x)](y)\n\nA one page site for the bakery,\nwith the menu.\n\nMore below.`)).toBe(
            `A one page site for the bakery, with the menu.`,
        );
    });

    it(`is empty for a README with nothing but a heading, which is what a new project starts with`, () => {
        expect(summaryOf(`# new-project\n`)).toBe(``);
    });
});

describe(`naming a new project`, () => {
    it(`offers the first free name in the series, so repeated presses do not collide`, () => {
        expect(freeProjectName([])).toBe(`new-project`);
        expect(freeProjectName([`new-project`])).toBe(`new-project-2`);
        expect(freeProjectName([`new-project`, `new-project-2`, `shop`])).toBe(`new-project-3`);
    });

    it(`turns what was typed into a folder name the daemon accepts`, () => {
        expect(slugOf(`  My Bakery Site! `)).toBe(`my-bakery-site`);
        expect(slugOf(`--weird..name--`)).toBe(`weird..name`);
        expect(slugOf(`###`)).toBe(``);
    });
});

describe(`where a tile goes`, () => {
    it(`opens the workspace rooted at the repository, and the preview on its own target`, () => {
        expect(projectPath(`tools/cli`)).toBe(`/workspace?dir=tools%2Fcli`);
        expect(previewPath(`shop`)).toBe(`/preview?target=repo%3Ashop`);
    });
});
