// @vitest-environment jsdom
//
// linkifyNoteRefs rewrites a real DOM (it is handed the sanitizer's fragment), so this file needs a document.
import { describe, expect, it } from "vitest";
import { linkifyNoteRefs, noteTitle, parseNote, projectLabel, resolveNoteLink, wikiLinkParts } from "./memoryNote";

/* The note model the whole view is titled, grouped and navigated by. Everything here runs against real shapes
 * the agent writes — the frontmatter template it uses, the slugs it names files and projects with, and the two
 * link syntaxes it cross-references its own notes in. */

describe(`parseNote`, () => {
    const NOTE = [
        `---`,
        `name: intentic-rtk-backend`,
        `description: "this sandbox runs filterBackend=rtk"`,
        `metadata: `,
        `  node_type: memory`,
        `  type: project`,
        `---`,
        ``,
        `The body.`,
    ].join(`\n`);

    it(`splits frontmatter off the body and reads the displayed fields`, () => {
        expect(parseNote(NOTE)).toEqual({
            description: `this sandbox runs filterBackend=rtk`,
            type: `project`,
            body: `\nThe body.`,
        });
    });

    it(`reads 'type' from under metadata without matching 'node_type'`, () => {
        expect(parseNote(NOTE).type).toBe(`project`);
    });

    it(`treats a note with no frontmatter as all body — MEMORY.md is exactly that`, () => {
        const index = `- [A note](a-note.md) — what it says\n`;
        expect(parseNote(index)).toEqual({ description: undefined, type: undefined, body: index });
    });

    it(`degrades to no chip and no subtitle rather than throwing on a malformed header`, () => {
        expect(parseNote(`---\nnot: closed\n`)).toEqual({ description: undefined, type: undefined, body: `---\nnot: closed\n` });
        expect(parseNote(`---\ndescription:\n---\nbody`)).toMatchObject({ description: undefined, body: `body` });
    });
});

describe(`noteTitle`, () => {
    it(`reads a slug filename as a sentence`, () => {
        expect(noteTitle(`intentic-sandbox-dogfood.md`)).toBe(`Intentic sandbox dogfood`);
    });

    it(`capitalises only the first word, so lowercase tool names survive`, () => {
        expect(noteTitle(`iq-failure-analysis.md`)).toBe(`Iq failure analysis`);
        expect(noteTitle(`fix-the-pattern-not-the-bug.md`)).toBe(`Fix the pattern not the bug`);
    });

    it(`titles a note in a subdirectory by its own name`, () => {
        expect(noteTitle(`people/radarsu-preferences.md`)).toBe(`Radarsu preferences`);
    });

    it(`falls back to the raw name when there is nothing to title`, () => {
        expect(noteTitle(`.md`)).toBe(`.md`);
    });
});

describe(`projectLabel`, () => {
    it(`reads a dashed cwd slug back as the path it was`, () => {
        expect(projectLabel(`-history-gits-root`)).toBe(`/history/gits/root`);
    });

    it(`puts a worktree UUID back together instead of splitting it into five segments`, () => {
        expect(projectLabel(`-history-worktrees-02802424-fe65-42f3-b713-3876b73bc6cd`)).toBe(
            `/history/worktrees/02802424-fe65-42f3-b713-3876b73bc6cd`,
        );
    });

    it(`leaves a project name that is not a path alone`, () => {
        expect(projectLabel(`intentic`)).toBe(`intentic`);
    });
});

describe(`resolveNoteLink`, () => {
    it(`resolves the relative links MEMORY.md is made of`, () => {
        expect(resolveNoteLink(`MEMORY.md`, `intentic-rtk-backend.md`)).toBe(`intentic-rtk-backend.md`);
    });

    it(`resolves against the linking note's own directory`, () => {
        expect(resolveNoteLink(`people/radarsu.md`, `./preferences.md`)).toBe(`people/preferences.md`);
        expect(resolveNoteLink(`people/radarsu.md`, `../MEMORY.md`)).toBe(`MEMORY.md`);
    });

    it(`reads an absolute href as project-relative — a note has no filesystem above its memory dir`, () => {
        expect(resolveNoteLink(`people/radarsu.md`, `/MEMORY.md`)).toBe(`MEMORY.md`);
    });

    it(`ignores a fragment or query on the way`, () => {
        expect(resolveNoteLink(`MEMORY.md`, `a-note.md#gotcha`)).toBe(`a-note.md`);
    });

    it(`leaves links that lead somewhere else alone`, () => {
        expect(resolveNoteLink(`MEMORY.md`, `https://intentic.dev`)).toBeUndefined();
        expect(resolveNoteLink(`MEMORY.md`, `//cdn.example.com/x.md`)).toBeUndefined();
        expect(resolveNoteLink(`MEMORY.md`, `mailto:a@b.c`)).toBeUndefined();
        expect(resolveNoteLink(`MEMORY.md`, `notes.txt`)).toBeUndefined();
        expect(resolveNoteLink(`MEMORY.md`, ``)).toBeUndefined();
    });
});

describe(`wikiLinkParts`, () => {
    it(`reads a bare wiki link as the target note's title`, () => {
        expect(wikiLinkParts(`intentic-worktree-toolchain`, undefined)).toEqual({
            name: `intentic-worktree-toolchain.md`,
            text: `Intentic worktree toolchain`,
        });
    });

    it(`keeps an explicit label as the author wrote it`, () => {
        expect(wikiLinkParts(`intentic-rtk-backend`, `the rtk note`)).toEqual({
            name: `intentic-rtk-backend.md`,
            text: `the rtk note`,
        });
    });

    it(`does not double the extension when the target already carries one`, () => {
        expect(wikiLinkParts(`MEMORY.md`, undefined).name).toBe(`MEMORY.md`);
    });
});

describe(`linkifyNoteRefs`, () => {
    const fragmentOf = (html: string): DocumentFragment => {
        const template = document.createElement(`template`);
        template.innerHTML = html;
        return template.content;
    };
    const decorated = (html: string, from = `MEMORY.md`): DocumentFragment => {
        const fragment = fragmentOf(html);
        linkifyNoteRefs(fragment, from);
        return fragment;
    };

    it(`turns the index's own entries into note references`, () => {
        const anchor = decorated(`<li><a href="intentic-rtk-backend.md">Intentic rtk backend</a></li>`).querySelector(`a`);
        expect(anchor?.dataset[`note`]).toBe(`intentic-rtk-backend.md`);
        // No href: the destination is a selection in this view, not somewhere the browser could navigate.
        expect(anchor?.hasAttribute(`href`)).toBe(false);
        expect(anchor?.classList.contains(`md-file-link`)).toBe(true);
    });

    it(`leaves a link that points out of the app exactly as it was`, () => {
        const anchor = decorated(`<p><a href="https://intentic.dev">docs</a></p>`).querySelector(`a`);
        expect(anchor?.getAttribute(`href`)).toBe(`https://intentic.dev`);
        expect(anchor?.dataset[`note`]).toBeUndefined();
    });

    it(`makes a wiki link a real link, titled by the note it points at`, () => {
        const fragment = decorated(`<p>See [[intentic-worktree-toolchain]] for why.</p>`);
        const anchor = fragment.querySelector(`a`);
        expect(anchor?.dataset[`note`]).toBe(`intentic-worktree-toolchain.md`);
        expect(anchor?.textContent).toBe(`Intentic worktree toolchain`);
        expect(fragment.textContent).toBe(`See Intentic worktree toolchain for why.`);
    });

    it(`keeps an explicit wiki-link label, and handles several in one sentence`, () => {
        const anchors = [...decorated(`<p>[[a-note|first]] then [[b-note]].</p>`).querySelectorAll(`a`)];
        expect(anchors.map((anchor) => anchor.textContent)).toEqual([`first`, `B note`]);
        expect(anchors.map((anchor) => anchor.dataset[`note`])).toEqual([`a-note.md`, `b-note.md`]);
    });

    it(`resolves a wiki link against the linking note's directory`, () => {
        const anchor = decorated(`<p>[[preferences]]</p>`, `people/radarsu.md`).querySelector(`a`);
        expect(anchor?.dataset[`note`]).toBe(`people/preferences.md`);
    });

    it(`leaves bracket text inside code alone — there it is literal, not a reference`, () => {
        const fragment = decorated(`<p><code>[[not-a-link]]</code> and <a href="x.md">[[nor this]]</a></p>`);
        expect(fragment.querySelector(`code`)?.textContent).toBe(`[[not-a-link]]`);
        expect(fragment.querySelectorAll(`a`)).toHaveLength(1);
    });

    // The label is whatever sat between the brackets, and it is written as a TEXT node — so a note whose link
    // label reads like markup renders that markup as the characters it is, not as an element.
    it(`writes link text as text, never as markup`, () => {
        const anchor = decorated(`<p>[[x|&lt;img src=x onerror=alert(1)&gt;]]</p>`).querySelector(`a`);
        expect(anchor?.textContent).toBe(`<img src=x onerror=alert(1)>`);
        expect(anchor?.children).toHaveLength(0);
    });
});
