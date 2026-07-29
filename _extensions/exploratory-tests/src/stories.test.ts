import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { slugOf, storiesOf, titleOf } from "./stories";

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

    it(`makes one story per file and groups by the first subdirectory`, () => {
        expect(storiesOf(`app`, entries)).toEqual([
            { path: `app/docs/user-stories/auth/01-sign-in.md`, slug: `01-sign-in`, title: `Sign in`, group: `auth` },
            { path: `app/docs/user-stories/auth/02-sign-out.feature`, slug: `02-sign-out`, title: `Sign out`, group: `auth` },
            { path: `app/docs/user-stories/checkout.md`, slug: `checkout`, title: `Checkout`, group: `` },
        ]);
    });

    it(`uses the fetched heading as the title when one was read`, () => {
        const titles = { "app/docs/user-stories/checkout.md": `# Guest checkout` };
        expect(storiesOf(`app`, [file(`app/docs/user-stories/checkout.md`)], titles)[0]?.title).toBe(`Guest checkout`);
    });

    it(`skips directories, dotfiles (the brief override lives among them) and non-story extensions`, () => {
        const noise = [
            dir(`app/docs/user-stories/auth`),
            file(`app/docs/user-stories/.exploratory.md`),
            file(`app/docs/user-stories/diagram.png`),
            file(`app/docs/user-stories/keep.md`),
        ];
        expect(storiesOf(`app`, noise).map((story) => story.slug)).toEqual([`keep`]);
    });

    it(`keeps same-named stories in different groups apart — one run directory each, no silent overwrite`, () => {
        const collide = [file(`app/docs/user-stories/auth/overview.md`), file(`app/docs/user-stories/billing/overview.md`)];
        expect(storiesOf(`app`, collide).map((story) => story.slug)).toEqual([`overview`, `overview-2`]);
    });
});
