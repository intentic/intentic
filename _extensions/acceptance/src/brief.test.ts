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
    it(`inlines the story rather than pointing at it: the agent must not go read the implementation instead`, () => {
        const text = brief();
        expect(text).toContain(story.content.trim().split(`\n`).slice(2).join(`\n`).trim());
        expect(text).toContain(story.path);
        expect(text).toContain(story.repo);
    });

    it(`names the base URL and forbids touching the app's lifecycle`, () => {
        const text = brief();
        expect(text).toContain(`http://localhost:5173`);
        expect(text).not.toBe(brief({ projectNotes: `other` }));
    });

    it(`tells the agent it is a tester: an unfixed defect is the deliverable`, () => {
        const withCriteria = brief({ criteria: [`Shows an error`] });
        expect(withCriteria).not.toBe(brief());
    });

    it(`names the deferred browser tools, which are invisible until something asks for them`, () => {
        const text = brief();
        expect(text).toContain(`ToolSearch`);
        expect(text).toContain(`+browser`);
        expect(text).toContain(`mcp__web__browser_navigate`);
    });

    it(`states the screenshot redirect and the per-shot copy out of the shared output directory`, () => {
        const text = brief();
        expect(text).toContain(`/work/.intentic/records/artifacts/browser`);
        expect(text).toContain(`cp /work/.intentic/records/artifacts/browser/`);
        expect(text).toContain(`/work/.intentic/records/artifacts/acceptance/rabc/01-sign-in/shots`);
    });

    it(`points both output files at this story's own run directory`, () => {
        const text = brief();
        expect(text).toContain(`/work/.intentic/records/artifacts/acceptance/rabc/01-sign-in/report.md`);
        expect(text).toContain(`/work/.intentic/records/artifacts/acceptance/rabc/01-sign-in/result.json`);
    });

    it(`carries the result.json shape the runs list reads back`, () => {
        const text = brief();
        expect(text).toContain(`"verdict": "pass | fail | blocked"`);
        expect(text).toContain(`"story": "01-sign-in"`);
    });

    /* The authored criteria are the contract the report is graded against: see brief.ts. They are numbered in
     * the instructions AND seeded verbatim into the result shape, because a positional array whose entries the
     * agent paraphrased cannot be lined up with what the story's author promised. */
    describe(`the authored criteria`, () => {
        const criteria = [`A wrong password shows an error`, `The email field keeps its value`];

        it(`enumerates them in order and pins the count`, () => {
            const text = brief({ criteria });
            for (const [index, item] of criteria.entries()) {
                expect(text).toContain(item);
                expect(text).toContain(String(index + 1));
            }
            expect(text).toContain(String(criteria.length));
            expect(text).not.toBe(brief());
        });

        it(`seeds the result shape with the criteria themselves, not with a placeholder`, () => {
            const text = brief({ criteria });
            for (const item of criteria) {
                expect(text).toContain(`"text": "${item}"`);
            }
        });

        it(`sends anything unpromised to defects rather than into the criteria list`, () => {
            expect(brief({ criteria })).not.toBe(brief());
        });

        it(`falls back to deriving them for a story that authored none`, () => {
            const text = brief();
            expect(text).not.toContain(`"text": "${criteria[0]}"`);
            expect(text).not.toBe(brief({ criteria }));
        });
    });

    it(`appends the repo's own notes last, as amendments rather than context the brief then contradicts`, () => {
        const notes = `Sign in as demo@example.com / hunter2.`;
        const text = brief({ projectNotes: `  ${notes}  ` });
        expect(text).toContain(`## Project-specific testing notes`);
        expect(text.trimEnd().endsWith(notes)).toBe(true);
    });

    it.each([undefined, ``, `   `])(`adds no notes section for %p`, (projectNotes) => {
        expect(brief({ projectNotes })).not.toContain(`Project-specific testing notes`);
    });
});
