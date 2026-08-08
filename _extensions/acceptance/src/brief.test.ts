import { describe, expect, it } from "vitest";
import { briefFor } from "./brief";
import type { RunStory } from "./runs";

const story: RunStory = {
    path: `app/docs/user-stories/auth/01-sign-in.md`,
    repo: `app`,
    group: `auth`,
    slug: `01-sign-in`,
    title: `Sign in`,
    conversationId: `xt-rabc-01-sign-in`,
    content: `# Sign in\n\nAs a user I can sign in with Google.\n`,
    criteria: [],
};

const brief = (over: { readonly criteria?: readonly string[]; readonly projectNotes?: string | undefined } = {}): string =>
    briefFor({
        story: { ...story, ...(over.criteria === undefined ? {} : { criteria: over.criteria }) },
        runId: `rabc`,
        baseUrl: `http://localhost:5173`,
        projectNotes: over.projectNotes,
    });

describe(`briefFor`, () => {
    it(`inlines the story rather than pointing at it — the agent must not go read the implementation instead`, () => {
        const text = brief();
        expect(text).toContain(`As a user I can sign in with Google.`);
        expect(text).toContain(`app/docs/user-stories/auth/01-sign-in.md`);
        expect(text).toContain(`the \`app\` repository`);
    });

    it(`names the base URL and forbids touching the app's lifecycle`, () => {
        const text = brief();
        expect(text).toContain(`Base URL: http://localhost:5173`);
        expect(text).toMatch(/Do not start, build, restart or reconfigure it/);
    });

    it(`tells the agent it is a tester — an unfixed defect is the deliverable`, () => {
        expect(brief()).toMatch(/Do not fix defects you find/);
    });

    it(`names the deferred browser tools, which are invisible until something asks for them`, () => {
        const text = brief();
        expect(text).toContain(`ToolSearch`);
        expect(text).toContain(`+browser`);
        expect(text).toContain(`mcp__web__browser_navigate`);
    });

    it(`states the screenshot redirect and the per-shot copy out of the shared output directory`, () => {
        const text = brief();
        expect(text).toContain(`/work/.intentic/artifacts/browser`);
        expect(text).toContain(`cp /work/.intentic/artifacts/browser/`);
        expect(text).toContain(`/work/.intentic/artifacts/acceptance/rabc/01-sign-in/shots`);
        expect(text).toMatch(/not in a batch at the end/);
    });

    it(`points both output files at this story's own run directory`, () => {
        const text = brief();
        expect(text).toContain(`/work/.intentic/artifacts/acceptance/rabc/01-sign-in/report.md`);
        expect(text).toContain(`/work/.intentic/artifacts/acceptance/rabc/01-sign-in/result.json`);
    });

    it(`carries the result.json shape the runs list reads back`, () => {
        const text = brief();
        expect(text).toContain(`"verdict": "pass | fail | blocked"`);
        expect(text).toContain(`"story": "01-sign-in"`);
    });

    /* The authored criteria are the contract the report is graded against — see brief.ts. They are numbered in
     * the instructions AND seeded verbatim into the result shape, because a positional array whose entries the
     * agent paraphrased cannot be lined up with what the story's author promised. */
    describe(`the authored criteria`, () => {
        const criteria = [`A wrong password shows an error`, `The email field keeps its value`];

        it(`enumerates them in order and pins the count`, () => {
            const text = brief({ criteria });
            expect(text).toContain(`1. A wrong password shows an error`);
            expect(text).toContain(`2. The email field keeps its value`);
            expect(text).toContain(`exactly these 2, in this order`);
        });

        it(`seeds the result shape with the criteria themselves, not with a placeholder`, () => {
            const text = brief({ criteria });
            expect(text).toContain(`"text": "A wrong password shows an error"`);
            expect(text).toContain(`"text": "The email field keeps its value"`);
        });

        it(`sends anything unpromised to defects rather than into the criteria list`, () => {
            expect(brief({ criteria })).toMatch(/do not add your own to the list/);
        });

        it(`falls back to deriving them for a story that authored none`, () => {
            const text = brief();
            expect(text).toMatch(/declares no explicit criteria section, so derive them/);
            expect(text).not.toContain(`in this order`);
        });
    });

    it(`appends the repo's own notes last, as amendments rather than context the brief then contradicts`, () => {
        const text = brief({ projectNotes: `  Sign in as demo@example.com / hunter2.  ` });
        expect(text).toContain(`## Project-specific testing notes`);
        expect(text.trimEnd().endsWith(`Sign in as demo@example.com / hunter2.`)).toBe(true);
    });

    it.each([undefined, ``, `   `])(`adds no notes section for %p`, (projectNotes) => {
        expect(brief({ projectNotes })).not.toContain(`Project-specific testing notes`);
    });
});
