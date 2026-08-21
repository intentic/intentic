import { describe, expect, it } from "vitest";
import { sumCounts, useCodeStats, type CodeCount } from "./useCodeStats";

/* THE THREE ANSWERS, kept apart. What this file is really pinning is that "I have not counted this yet" never
 * leaves here looking like "there is nothing to count": those two used to arrive as the same absent value, and a
 * badge that cannot tell them apart prints git's number for both and then replaces one of them under the reader.
 *
 * The store is module state shared by every review surface, so each case works on a key of its own. Counted
 * against the real TypeScript grammar, like codeStat's own tests: what a comment is has to be the tokenizer's
 * answer here too. */

const { record, noCode, countOf } = useCodeStats();

const COMMENT_ADDED = [`/* a paragraph`, ` * about what`, ` * this does */`, `const a = 1;`, `const b = 2;`].join(`\n`);

describe(`useCodeStats`, () => {
    it(`says a file it has not read is still being counted, rather than answering with git's number`, () => {
        expect(countOf(`unread`)).toEqual({ counting: true });
    });

    it(`answers with the stripped counts once the file has been read`, async () => {
        await record(`counted`, `a.ts`, `const a = 1;`, COMMENT_ADDED);

        // Git would call this +4: four of the five added lines are comment.
        expect(countOf(`counted`)).toEqual({ code: { additions: 1, deletions: 0 }, counting: false });
    });

    it(`settles a file it has no grammar to strip as git's own reading, an answer, not an absence`, async () => {
        await record(`no-grammar`, `notes.unknownext`, `one`, `two`);

        // No `code`, so the badge prints git's numbers, and `counting: false` is what stops it saying "…" forever.
        expect(countOf(`no-grammar`)).toEqual({ counting: false });
    });

    it(`writes off a diff there was no text to read: bytes, or one too big for the daemon to send`, () => {
        noCode(`bytes`);

        expect(countOf(`bytes`)).toEqual({ counting: false });
    });

    it(`ends on the version that arrived last when a file is written again mid-count`, async () => {
        // The background reader and a click land on the same file constantly, and an agent writes while both are in
        // flight. Whichever content came last is the one on screen, so it has to be the one counted.
        await Promise.all([record(`racing`, `a.ts`, ``, `const a = 1;`), record(`racing`, `a.ts`, ``, [`const a = 1;`, `const b = 2;`].join(`\n`))]);

        expect(countOf(`racing`).code).toEqual({ additions: 2, deletions: 0 });
    });

    it(`recounts a file the agent has written again rather than answering about the version before it`, async () => {
        await record(`rewritten`, `a.ts`, ``, `const a = 1;`);
        expect(countOf(`rewritten`).code).toEqual({ additions: 1, deletions: 0 });

        await record(`rewritten`, `a.ts`, ``, [`const a = 1;`, `const b = 2;`].join(`\n`));
        expect(countOf(`rewritten`).code).toEqual({ additions: 2, deletions: 0 });
    });
});

const code = (additions: number, deletions: number): { count: CodeCount } => ({ count: { code: { additions, deletions }, counting: false } });

describe(`sumCounts`, () => {
    it(`adds the code's numbers where a file was stripped and git's where there was nothing to strip`, () => {
        expect(
            sumCounts([
                code(3, 1),
                // Nothing to strip: its pane shows every line it has, so its git counts ARE its code-only reading.
                { count: { counting: false }, additions: 40, deletions: 2 },
            ]),
        ).toEqual({ code: { additions: 43, deletions: 3 }, counting: false });
    });

    it(`stays pending while any row is, because part of a sum is not a sum`, () => {
        // The old behaviour totalled what it happened to know: a heading that agreed with neither git nor its own
        // rows, and that re-totalled every time the reader clicked one of them.
        expect(sumCounts([code(3, 1), { count: { counting: true }, additions: 40, deletions: 2 }])).toEqual({ counting: true });
    });

    it(`is nothing at all for no rows, so an emptied group prints an empty badge`, () => {
        expect(sumCounts([])).toEqual({ code: { additions: 0, deletions: 0 }, counting: false });
    });
});
