import { describe, expect, it } from "vitest";
import { mapBrief, packageBrief } from "./brief.js";
import type { DocComponent } from "./docModel.js";

/* The briefs are the only specialization seam a conversation has, so what they say is what the documents become.
 * These tests pin the properties that were reasoned about rather than the prose: that an agent is told where to
 * write (staging, never the repo), that it is handed the map's vocabulary instead of a path to go read, and that
 * the optional sections cannot collapse the paragraph structure around them. */

const component: DocComponent = { id: `wire`, name: `The wire`, oneLiner: `The shared schemas.`, packages: [`_libs/contract`], accent: `2` };

describe(`mapBrief`, () => {
    const brief = mapBrief({ repo: `intentic`, label: `intentic` });

    it(`sends the map to staging and explicitly away from the repository`, () => {
        expect(brief).toContain(`.intentic/docs/intentic/repo.json`);
        expect(brief).toContain(`.intentic/docs/intentic/repo.md`);
        expect(brief).toContain(`Do not create or edit anything under the repository itself`);
        // The published tree is the owner's to write, via Publish. A brief that named it would be publishing.
        expect(brief).not.toContain(`intentic/docs/architecture/`);
    });

    it(`starts from the tool rather than from reading, and scopes the tool to this repo`, () => {
        expect(brief).toContain(`intentic-docs facts --repo intentic`);
        expect(brief).toContain(`do not restate it from reading`);
    });

    it(`takes provenance from the tool's own head, never from an injected revision`, () => {
        expect(brief).toContain(`the \`head\` field of the \`intentic-docs facts\` output`);
    });

    it(`asks for components, vocabulary and reading order — and for no package prose`, () => {
        expect(brief).toContain(`Logical components`);
        expect(brief).toContain(`Vocabulary`);
        expect(brief).toContain(`Reading order`);
        expect(brief).toContain(`You are not documenting any single package`);
    });

    it(`teaches the figure fences verbatim, so the model does not invent a format`, () => {
        expect(brief).toContain(`\`\`\`dag`);
        expect(brief).toContain(`\`\`\`bars`);
        expect(brief).toContain(`\`\`\`stats`);
    });

    it(`forbids hand-writing the generated index`, () => {
        expect(brief).toContain(`index.json`);
        expect(brief).toContain(`Never write it by hand`);
    });

    it(`omits the --repo flag for the workspace root repo, whose name is empty`, () => {
        // `intentic-docs facts --repo ` with nothing after it would consume the next token as the repo.
        const root = mapBrief({ repo: ``, label: `the workspace root` });
        expect(root).toContain(`intentic-docs facts\n`);
        expect(root).not.toContain(`--repo `);
        expect(root).toContain(`.intentic/docs/root/repo.json`);
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
        // The page IS the package's README. It still STAGES, though — publishing is what puts it in the package.
        expect(brief).toContain(`.intentic/docs/intentic/_libs/contract/README.md`);
        expect(brief).toContain(`## Write exactly one file`);
    });

    it(`spells out the two things the tool parses back out of the page`, () => {
        // A page missing either is a package with no one-liner and no anchors anywhere in the app.
        expect(brief).toContain(`## Key files`);
        expect(brief).toContain(`becomes the package's one-liner`);
    });

    it(`inlines the component and its accent, so figures across the set agree`, () => {
        expect(brief).toContain(`**The wire** component`);
        expect(brief).toContain(`accent slot "2"`);
    });

    it(`inlines the glossary rather than pointing at the map`, () => {
        // A path to go read costs a turn and invites the agent to drift; the vocabulary is small enough to hand over.
        expect(brief).toContain(`**panel** — A repo's dev server.`);
    });

    it(`protects the map and the sibling packages from a fan-out agent`, () => {
        expect(brief).toContain(`Another agent is documenting each other package right now`);
        expect(brief).toContain(`repo.json\` belongs to the map`);
    });

    /* A package page has NO provenance to write — its date is the commit that lands it and its staleness is a
     * commit count, both computed. Asking an agent for a field it cannot get right is how the previous layout
     * ended up with 61 stale pages out of 69. */
    it(`asks for no provenance, and says why there is none to give`, () => {
        expect(brief).not.toContain(`"sourceRev"`);
        expect(brief).toContain(`There is no provenance to write`);
    });

    it(`tells the package agent not to hand-write the facts the app computes`, () => {
        expect(brief).toContain(`**Do not draw the facts.**`);
    });

    it(`rules out the API reference a coding model defaults to`, () => {
        expect(brief).toContain(`No heading called "API"`);
        expect(brief).toContain(`No list of exports`);
    });

    it(`tells an unassigned package not to redraw the map`, () => {
        const orphan = packageBrief({ repo: `r`, label: `r`, dir: `p`, glossary: [], components: [] });
        expect(orphan).toContain(`do not redraw the map`);
    });

    /* The optional sections are assembled as BLOCKS joined by a blank line rather than as lines joined by a
     * newline. An earlier revision filtered empty strings out of a line array, which silently removed the
     * paragraph breaks as well and produced one run-on wall of text. */
    it(`keeps its paragraph structure when the optional sections are absent`, () => {
        const bare = packageBrief({ repo: `r`, label: `r`, dir: `p`, glossary: [], components: [] });
        expect(bare).not.toContain(`This repository's vocabulary`);
        expect(bare).toContain(`\n\n## Where this package sits`);
        expect(bare).toContain(`\n\n## Write exactly one file`);
        // No heading is ever glued to the line above it.
        expect(/[^\n]\n## /.test(bare)).toBe(false);
    });

    it(`keeps its paragraph structure when they are present`, () => {
        expect(/[^\n]\n## /.test(brief)).toBe(false);
    });
});
