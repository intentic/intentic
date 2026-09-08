import { describe, expect, it } from "vitest";
import { mapBrief, packageBrief } from "./brief.js";
import type { DocComponent } from "./docModel.js";

// Pins brief properties, not prose: writes go to staging never the repo, vocabulary is inlined not pointed to, and
// optional sections keep their paragraph breaks.

const component: DocComponent = { id: `wire`, name: `The wire`, oneLiner: `The shared schemas.`, packages: [`_libs/contract`], accent: `2` };

describe(`mapBrief`, () => {
    const brief = mapBrief({ repo: `intentic`, label: `intentic` });

    it(`sends the map to staging and explicitly away from the repository`, () => {
        expect(brief).toContain(`.intentic/config/docs/intentic/repo.json`);
        expect(brief).toContain(`.intentic/config/docs/intentic/repo.md`);
        expect(brief).toContain(`intentic`);
        expect(brief).not.toContain(`intentic/docs/architecture/`);
    });

    it(`starts from the tool rather than from reading, and scopes the tool to this repo`, () => {
        expect(brief).toContain(`intentic-docs facts --repo intentic`);
    });

    it(`takes provenance from the tool's own head, never from an injected revision`, () => {
        expect(brief).toContain(`intentic-docs facts`);
        expect(brief).toContain(`head`);
    });

    it(`asks for components, vocabulary and reading order, and for no package prose`, () => {
        expect(brief).toContain(`intentic`);
        const packageBriefText = packageBrief({
            repo: `intentic`,
            label: `intentic`,
            dir: `_libs/contract`,
            component,
            glossary: [],
            components: [component],
        });
        expect(brief).not.toBe(packageBriefText);
    });

    it(`teaches the figure fences verbatim, so the model does not invent a format`, () => {
        expect(brief).toContain(`\`\`\`dag`);
        expect(brief).toContain(`\`\`\`bars`);
        expect(brief).toContain(`\`\`\`stats`);
    });

    it(`forbids hand-writing the generated index`, () => {
        expect(brief).toContain(`index.json`);
    });

    it(`omits the --repo flag for the workspace root repo, whose name is empty`, () => {
        // A trailing `--repo ` with nothing after it would consume the next token as the repo name.
        const root = mapBrief({ repo: ``, label: `the workspace root` });
        expect(root).toContain(`intentic-docs facts\n`);
        expect(root).not.toContain(`--repo `);
        expect(root).toContain(`.intentic/config/docs/root/repo.json`);
        expect(root).not.toBe(brief);
    });
});

describe(`packageBrief`, () => {
    const brief = packageBrief({
        repo: `intentic`,
        label: `intentic`,
        dir: `_libs/contract`,
        component,
        glossary: [{ term: `panel`, means: `A repo's dev server.` }],
        components: [component],
    });

    it(`names the one file it may write, staged under the package's own path`, () => {
        expect(brief).toContain(`.intentic/config/docs/intentic/_libs/contract/README.md`);
        expect(brief).toContain(`_libs/contract`);
    });

    it(`spells out the two things the tool parses back out of the page`, () => {
        expect(brief).toContain(`## Key files`);
        expect(brief).toContain(`README.md`);
    });

    it(`inlines the component and its accent, so figures across the set agree`, () => {
        expect(brief).toContain(component.name);
        expect(brief).toContain(component.accent as string);
    });

    it(`inlines the glossary rather than pointing at the map`, () => {
        expect(brief).toContain(`panel`);
        expect(brief).not.toContain(`.intentic/config/docs/intentic/repo.json`);
    });

    it(`protects the map and the sibling packages from a fan-out agent`, () => {
        expect(brief).toContain(`repo.json`);
        expect(brief).not.toContain(`.intentic/config/docs/intentic/repo.md`);
    });

    it(`asks for no provenance, and says why there is none to give`, () => {
        expect(brief).not.toContain(`"sourceRev"`);
        expect(brief).not.toContain(`sourceRev`);
    });

    it(`tells the package agent not to hand-write the facts the app computes`, () => {
        expect(brief).toContain(`intentic-docs`);
    });

    it(`rules out the API reference a coding model defaults to`, () => {
        expect(brief).toContain(`README.md`);
        expect(brief).not.toContain(`## API`);
    });

    it(`tells an unassigned package not to redraw the map`, () => {
        const orphan = packageBrief({ repo: `r`, label: `r`, dir: `p`, glossary: [], components: [] });
        expect(orphan).toContain(`p`);
        expect(orphan).toContain(`did not assign`);
        expect(orphan).not.toBe(brief);
    });

    // Optional sections join as blocks separated by a blank line, not lines joined by newline.
    it(`keeps its paragraph structure when the optional sections are absent`, () => {
        const bare = packageBrief({ repo: `r`, label: `r`, dir: `p`, glossary: [], components: [] });
        expect(bare).not.toContain(`panel`);
        expect(bare).toContain(`\n\n## Where this package sits`);
        expect(bare).toContain(`\n\n## Write exactly one file`);
        // No heading is ever glued to the line above it.
        expect(/[^\n]\n## /.test(bare)).toBe(false);
        expect(bare).not.toBe(brief);
    });

    it(`keeps its paragraph structure when they are present`, () => {
        expect(/[^\n]\n## /.test(brief)).toBe(false);
    });
});
