import { describe, expect, test } from "vitest";
import { extensionBrief, tightenBrief } from "./extensionBrief";

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

describe(`the brief for tightening permissions`, () => {
    const tighten = tightenBrief({
        id: `workspace.release-notes`,
        dir: `.intentic/workspace-extensions/release-notes`,
        unused: [`POST /agent`, `GET /panels`],
        used: [{ route: `GET /workspace/file`, calls: 1240 }],
    });

    test(`shows both sides of the evidence, so the claim can be weighed`, () => {
        // The used counts are what make "never called" mean anything: without them the agent cannot tell an
        // exercised extension from one nobody has opened, and both produce the same list of zeroes.
        expect(tighten).toContain(`POST /agent, GET /panels`);
        expect(tighten).toContain(`GET /workspace/file (1,240)`);
    });

    test(`asks for a decision per route, not for the marked ones to be deleted`, () => {
        // The failure this exists to prevent: an agent that treats the panel's marks as a task list and strips a
        // route an error path needs. Keeping one with a reason has to read as success.
        expect(tighten).toContain(`Remove a route only when nothing in the code can reach it`);
        expect(tighten).toContain(`one-line reason`);
    });

    test(`forbids the turn from widening into the code`, () => {
        // Behaviour changes are how a "tidy the manifest" turn becomes a diff nobody can review.
        expect(tighten).toContain(`edits \`permissions.sandbox\` and nothing else`);
    });
});
