import { describe, expect, test } from "vitest";
import { extensionBrief } from "./extensionBrief";

/* What the brief must not lose. These are not assertions about wording — they are the four things an agent
 * cannot recover on its own, each of which produced a directory that stopped loading when it was missing. */

const brief = extensionBrief({
    id: `workspace.release-notes`,
    dir: `.intentic/workspace-extensions/release-notes`,
    wish: `  a list of what shipped this week, from the git log  `,
});

describe(`the brief handed to an authoring agent`, () => {
    test(`carries the author's own words, not a paraphrase of them`, () => {
        // Quoted verbatim (trimmed) so the person and the agent argue about one statement of the goal. A brief
        // that summarised the wish would be the prompt author guessing at a request they were handed exactly.
        expect(brief).toContain(`"a list of what shipped this week, from the git log"`);
    });

    test(`names the two files by path, so nothing has to be searched for`, () => {
        expect(brief).toContain(`.intentic/workspace-extensions/release-notes/extension.js`);
        expect(brief).toContain(`.intentic/workspace-extensions/release-notes/intentic-extension.json`);
    });

    test(`states every constraint that is invisible from inside the directory`, () => {
        // The four ways this goes wrong for an agent that knows Vue and not this host: bundling it, writing an
        // SFC, registering something the manifest never declared, and helping itself to daemon routes.
        expect(brief).toContain(`ONE file`);
        expect(brief).toContain(`h()`);
        expect(brief).toContain(`Declare every contribution`);
        expect(brief).toContain(`permissions.sandbox`);
    });

    test(`ends on something the agent can check rather than claim`, () => {
        // "It still loads" is readable off the Extensions tab, which names a directory that stopped parsing —
        // so finishing is verifiable without the author being there.
        expect(brief).toContain(`Not loadable`);
        expect(brief).toContain(`workspace.release-notes`);
    });
});
