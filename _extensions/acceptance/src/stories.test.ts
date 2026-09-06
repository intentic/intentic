import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { criteriaOf, newStoryMarkdown, slugOf, type Story, storiesOf, storyPath, targetKeyOf, titleOf, uniqueOf } from "./stories";

const file = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).pop() ?? path, path, type: `file` });
const dir = (path: string): WorkspaceTreeEntry => ({ name: path.split(`/`).pop() ?? path, path, type: `dir` });

describe(`slugOf`, () => {
    it(`reduces a filename to the alphabet a conversation id and a directory name both accept`, () => {
        expect(slugOf(`app/docs/user-stories/03 Reset Password!.md`)).toBe(`03-reset-password`);
    });

    it(`caps length, so the run id it is concatenated with survives the 64-char conversation id limit`, () => {
        expect(slugOf(`${`a`.repeat(120)}.md`)).toHaveLength(40);
    });

    it(`falls back rather than producing an empty slug for a name with nothing latin in it`, () => {
        expect(slugOf(`docs/user-stories/日本語.md`)).toBe(`story`);
    });
});

describe(`titleOf`, () => {
    it(`takes the first markdown heading`, () => {
        expect(titleOf(`a/docs/user-stories/01-login.md`, `<!-- note -->\n\n# Sign in with Google\n\nAs a user…`)).toBe(`Sign in with Google`);
    });

    it(`takes Gherkin's Feature line`, () => {
        expect(titleOf(`a/docs/user-stories/checkout.feature`, `Feature: Guest checkout\n  Scenario: …`)).toBe(`Guest checkout`);
    });

    it(`ignores a heading far enough down to be a section rather than the document's name`, () => {
        expect(titleOf(`a/docs/user-stories/01-login.md`, `${`\n`.repeat(40)}# Appendix`)).toBe(`Login`);
    });

    it(`de-slugs the filename when there is no heading, dropping the ordering prefix`, () => {
        expect(titleOf(`a/docs/user-stories/03-reset_password.md`, ``)).toBe(`Reset password`);
    });

    it(`de-slugs the filename when the file could not be read at all`, () => {
        expect(titleOf(`a/docs/user-stories/checkout.md`, undefined)).toBe(`Checkout`);
    });
});

describe(`storiesOf`, () => {
    const entries = [
        file(`app/docs/user-stories/checkout.md`),
        dir(`app/docs/user-stories/auth`),
        file(`app/docs/user-stories/auth/01-sign-in.md`),
        file(`app/docs/user-stories/auth/02-sign-out.feature`),
    ];

    it(`makes one story per file, tagged with its repo, grouped by the first subdirectory`, () => {
        expect(storiesOf(`app`, entries)).toEqual([
            { repo: `app`, path: `app/docs/user-stories/auth/01-sign-in.md`, slug: `01-sign-in`, title: `Sign in`, group: `auth` },
            { repo: `app`, path: `app/docs/user-stories/auth/02-sign-out.feature`, slug: `02-sign-out`, title: `Sign out`, group: `auth` },
            { repo: `app`, path: `app/docs/user-stories/checkout.md`, slug: `checkout`, title: `Checkout`, group: `` },
        ]);
    });

    it(`uses the fetched heading as the title when one was read`, () => {
        const titles = { "app/docs/user-stories/checkout.md": `# Guest checkout` };
        expect(storiesOf(`app`, [file(`app/docs/user-stories/checkout.md`)], titles)[0]?.title).toBe(`Guest checkout`);
    });

    it(`skips directories, dotfiles (the brief override lives among them) and non-story extensions`, () => {
        const noise = [
            dir(`app/docs/user-stories/auth`),
            file(`app/docs/user-stories/.acceptance.md`),
            file(`app/docs/user-stories/diagram.png`),
            file(`app/docs/user-stories/keep.md`),
        ];
        expect(storiesOf(`app`, noise).map((story) => story.slug)).toEqual([`keep`]);
    });

    it(`keeps same-named stories in different groups apart: one run directory each, no silent overwrite`, () => {
        const collide = [file(`app/docs/user-stories/auth/overview.md`), file(`app/docs/user-stories/billing/overview.md`)];
        expect(storiesOf(`app`, collide).map((story) => story.slug)).toEqual([`overview`, `overview-2`]);
    });
});

/* The cross-repo half of the same guard. storiesOf only ever sees one repo, so two repos that both ship
 * `checkout.md` derive the same conversation id and the same run directory: two agents overwriting each other's
 * report, which is precisely what the within-repo renumbering above exists to prevent. */
describe(`uniqueOf`, () => {
    const story = (repo: string, slug: string): Story => ({ repo, path: `${repo}/docs/user-stories/${slug}.md`, slug, title: slug, group: `` });

    it(`renumbers a slug two repos both produced`, () => {
        expect(uniqueOf([story(`site`, `checkout`), story(`api`, `checkout`)]).map((entry) => entry.slug)).toEqual([`checkout`, `checkout-2`]);
    });

    it(`leaves distinct slugs alone`, () => {
        expect(uniqueOf([story(`site`, `checkout`), story(`api`, `orders`)]).map((entry) => entry.slug)).toEqual([`checkout`, `orders`]);
    });
});

/* ---- the criteria section: what a run is graded against ---- */

describe(`criteriaOf`, () => {
    const story = [
        `# Sign in`,
        ``,
        `As a user I can sign in.`,
        ``,
        `## Acceptance criteria`,
        ``,
        `- [ ] A wrong password shows an error`,
        `- [x] Ticked is still just a criterion`,
        `* A bare bullet counts too`,
    ].join(`\n`);

    it(`reads the checklist under the criteria heading, whatever the box state`, () => {
        expect(criteriaOf(story)).toEqual([`A wrong password shows an error`, `Ticked is still just a criterion`, `A bare bullet counts too`]);
    });

    it(`stops at the next heading of any level, so a following section is not eaten`, () => {
        expect(criteriaOf(`## Acceptance criteria\n\n- One\n\n### Notes\n\n- Not a criterion`)).toEqual([`One`]);
    });

    it(`is case-insensitive about the heading, since authors write it either way`, () => {
        expect(criteriaOf(`## ACCEPTANCE CRITERIA\n- One`)).toEqual([`One`]);
    });

    it.each([undefined, ``, `# Sign in\n\nJust prose.`])(`yields none for %p: a story without the section is still a story`, (content) => {
        expect(criteriaOf(content)).toEqual([]);
    });
});

/* A story the composer mints has to be one the parsers read back: a story started here and a story hand-written
 * in an editor are the same artifact, or the format has forked. */
describe(`newStoryMarkdown`, () => {
    const written = newStoryMarkdown(`  Sign in  `);

    /* The whole document to the byte, because every part of it is load-bearing and the parsers below only read
     * the parts they name. The empty bullet is where the caret lands and where Enter then keeps going, so it
     * has to be a LIST LINE the editor's continuation recognises rather than a bare dash, and the blank line
     * above the heading is what keeps that section a heading rather than a paragraph's second line. */
    it(`is the trimmed title, the section the run grades against, and an empty bullet to type into`, () => {
        expect(written).toBe(`# Sign in\n\n## Acceptance criteria\n\n- \n`);
    });

    /* And it has to read back as the story it looks like: a fresh story promises nothing, so the row's tally
     * says "no criteria" until somebody types one, and the empty bullet must not count as the first. */
    it(`round-trips through the parsers as a titled story with no criteria yet`, () => {
        expect(titleOf(`x.md`, written)).toBe(`Sign in`);
        expect(criteriaOf(written)).toEqual([]);
    });
});

describe(`storyPath`, () => {
    it(`names a new story's file after its slug, under the repo's stories directory`, () => {
        expect(storyPath(`site`, ``, `sign-in`)).toBe(`site/docs/user-stories/sign-in.md`);
    });

    it(`puts a grouped story in its subdirectory, which is where storiesOf reads the group back from`, () => {
        expect(storyPath(`site`, `01-arrive`, `sign-in`)).toBe(`site/docs/user-stories/01-arrive/sign-in.md`);
    });
});

/* One repository can serve several applications: a monorepo's marketing site and its web app are two dev
 * servers on two ports, and the group is the only thing in a stories tree that already says which is which. */
describe(`targetKeyOf`, () => {
    it(`aims a grouped story at its own address`, () => {
        expect(targetKeyOf({ repo: `intentic`, group: `01-arrive` })).toBe(`intentic/01-arrive`);
    });

    it(`leaves an ungrouped story on its repo, which is what every run resolved before groups could be aimed`, () => {
        expect(targetKeyOf({ repo: `intentic`, group: `` })).toBe(`intentic`);
    });

    it(`keeps two groups of one repo apart, so each can point at a different server`, () => {
        expect(targetKeyOf({ repo: `intentic`, group: `01-arrive` })).not.toBe(targetKeyOf({ repo: `intentic`, group: `02-setup` }));
    });
});
