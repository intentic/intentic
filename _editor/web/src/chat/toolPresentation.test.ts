import { PLAN_DOCUMENTS_DIR } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { numberedFileBody, present, TEXT_CAP } from "./toolPresentation";

// A completed call with no output, spread over per-case.
const tool = (over: Partial<TranscriptTool> & Pick<TranscriptTool, "name">): TranscriptTool => ({
    id: `t1`,
    category: `other`,
    status: `completed`,
    ...over,
});

const withText = (name: string, text: string, over: Partial<TranscriptTool> = {}): TranscriptTool => tool({ name, content: [{ type: `text`, text }], ...over });

// The SDK's numbered file view a Read returns: a right-padded line number, an arrow (or tab), then the content.
const numbered = (lines: string[], start = 1, sep = `→`): string =>
    lines.map((line, index) => `${String(start + index).padStart(6)}${sep}${line}`).join(`\n`);

describe(`present: icons`, () => {
    it(`falls back to the ACP category when no presenter claims the name`, () => {
        expect(present(tool({ name: `mcp__db__query`, category: `search` })).icon).toBe(`search`);
        expect(present(tool({ name: `Whatever`, category: `other` })).icon).toBe(`cog`);
    });

    it(`lets a per-name presenter override the category icon`, () => {
        // The subagent tool categorizes as `other` but reads as a delegation. The Claude SDK
        // names it `Agent`; native backends emit lowercase `task`: both resolve to the delegation icon.
        expect(present(tool({ name: `Agent`, category: `other` })).icon).toBe(`users`);
        expect(present(tool({ name: `Task`, category: `other` })).icon).toBe(`users`);
    });

    it(`matches presenter names case-insensitively, so a backend's lowercase id resolves`, () => {
        expect(present(withText(`grep`, `a/b.ts`)).body?.kind).toBe(`files`);
        expect(present(withText(`Grep`, `a/b.ts`)).body?.kind).toBe(`files`);
    });
});

describe(`present: bodies`, () => {
    it(`gives an output-less call no body, so its card renders as a bare header`, () => {
        expect(present(tool({ name: `Read` })).body).toBeUndefined();
    });

    it(`splits a Bash call into its command line and its output`, () => {
        const result = present(withText(`Bash`, `hello\n`, { target: `echo hello`, category: `execute` }));
        expect(result.body).toEqual({ kind: `command`, command: `echo hello`, output: `hello\n` });
    });

    it(`keeps a Bash body even when the command printed nothing: the command line is the point`, () => {
        const result = present(tool({ name: `Bash`, target: `rm -rf /tmp/x`, category: `execute` }));
        expect(result.body).toEqual({ kind: `command`, command: `rm -rf /tmp/x`, output: `` });
    });

    it(`parses a plain path listing into clickable rows`, () => {
        const result = present(withText(`Glob`, `src/a.ts\nsrc/b.ts\n`));
        expect(result.body).toEqual({ kind: `files`, entries: [{ path: `src/a.ts` }, { path: `src/b.ts` }], hidden: 0 });
    });

    it(`carries the line number out of a ripgrep path:line:match line`, () => {
        const result = present(withText(`Grep`, `src/a.ts:42:const x = 1\nsrc/b.ts:7:const y = 2`));
        expect(result.body).toEqual({
            kind: `files`,
            entries: [
                { path: `src/a.ts`, line: 42 },
                { path: `src/b.ts`, line: 7 },
            ],
            hidden: 0,
        });
    });

    it(`degrades to plain text when the output is not really a path listing`, () => {
        // A search tool may return prose or counts depending on the agent's chosen output mode; half-parsing
        // that into a file list would render rows that go nowhere.
        const text = `No matches found\nTry a broader pattern`;
        expect(present(withText(`Grep`, text)).body).toEqual({ kind: `text`, text });
    });

    it(`does not mistake a flag echo for a path`, () => {
        const text = `--include=*.ts\n--glob=!node_modules`;
        expect(present(withText(`Grep`, text)).body).toEqual({ kind: `text`, text });
    });

    it(`caps file rows and reports how many it hid`, () => {
        const paths = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`).join(`\n`);
        const body = present(withText(`Glob`, paths)).body;
        expect(body?.kind).toBe(`files`);
        if (body?.kind !== `files`) {
            throw new Error(`expected a files body`);
        }
        expect(body.entries).toHaveLength(50);
        expect(body.hidden).toBe(10);
    });

    it(`truncates a huge text body`, () => {
        const body = present(withText(`Read`, `x`.repeat(TEXT_CAP + 500))).body;
        expect(body).toEqual({ kind: `text`, text: `${`x`.repeat(TEXT_CAP)}\n… (truncated)` });
    });
});

describe(`present: read code body`, () => {
    it(`strips the SDK line-number gutter and resolves the lang from the read path`, () => {
        const text = numbered([`export const x = 1;`, `const y = 2;`]);
        const body = present(withText(`Read`, text, { locations: [{ path: `src/a.ts` }] })).body;
        expect(body).toEqual({ kind: `code`, code: `export const x = 1;\nconst y = 2;`, lang: `typescript`, firstLine: 1 });
    });

    it(`keeps the file's own first line number (Read honors an offset)`, () => {
        const text = numbered([`def f():`, `    return 1`], 40);
        const body = present(withText(`Read`, text, { locations: [{ path: `app/main.py` }] })).body;
        expect(body).toEqual({ kind: `code`, code: `def f():\n    return 1`, lang: `python`, firstLine: 40 });
    });

    it(`falls back to the target path for the lang when no locations are carried`, () => {
        const text = numbered([`body { color: red; }`]);
        const body = present(withText(`Read`, text, { target: `site/app.css` })).body;
        expect(body).toEqual({ kind: `code`, code: `body { color: red; }`, lang: `css`, firstLine: 1 });
    });

    it(`still shows a code body (uncolored) for a file whose extension we ship no grammar for`, () => {
        const text = numbered([`alpha`, `beta`]);
        const body = present(withText(`Read`, text, { locations: [{ path: `notes.xyz` }] })).body;
        expect(body).toEqual({ kind: `code`, code: `alpha\nbeta`, lang: undefined, firstLine: 1 });
    });

    it(`degrades a non-numbered read (an image/PDF read) to a plain text body`, () => {
        expect(present(withText(`Read`, `[image]`, { locations: [{ path: `logo.png` }] })).body).toEqual({ kind: `text`, text: `[image]` });
    });

    it(`does not treat non-contiguous numbered prose as a file`, () => {
        const text = `1→first point\n3→third point`;
        expect(present(withText(`Read`, text, { locations: [{ path: `a.ts` }] })).body).toEqual({ kind: `text`, text });
    });

    it(`starts a settled read collapsed like any other body`, () => {
        expect(present(withText(`Read`, numbered([`x`]), { locations: [{ path: `a.ts` }] })).defaultOpen).toBe(false);
    });
});

describe(`numberedFileBody`, () => {
    it(`strips an arrow-separated gutter and reports the first line`, () => {
        expect(numberedFileBody(`     1→a\n     2→b`)).toEqual({ code: `a\nb`, firstLine: 1 });
    });

    it(`accepts a tab-separated gutter too`, () => {
        expect(numberedFileBody(`1\ta\n2\tb`)).toEqual({ code: `a\nb`, firstLine: 1 });
    });

    it(`preserves blank lines inside the file`, () => {
        expect(numberedFileBody(`1→a\n2→\n3→c`)).toEqual({ code: `a\n\nc`, firstLine: 1 });
    });

    it(`tolerates a trailing truncation marker`, () => {
        expect(numberedFileBody(`1→a\n2→b\n… (truncated)`)).toEqual({ code: `a\nb\n… (truncated)`, firstLine: 1 });
    });

    it(`rejects anything that is not a numbered file view`, () => {
        expect(numberedFileBody(``)).toBeUndefined();
        expect(numberedFileBody(`just some prose\nmore prose`)).toBeUndefined();
        expect(numberedFileBody(`1→a\n3→b`)).toBeUndefined();
    });
});

describe(`present: summaries`, () => {
    it(`counts matches for a search and lines for a read`, () => {
        expect(present(withText(`Grep`, `a/b.ts\na/c.ts`)).summary).toBe(`2 matches`);
        expect(present(withText(`Read`, `l1\nl2\nl3`)).summary).toBe(`3 lines`);
    });

    it(`singularizes a count of one`, () => {
        expect(present(withText(`Grep`, `a/b.ts`)).summary).toBe(`1 match`);
    });

    it(`reports an empty search as "no matches" rather than "0 matches"`, () => {
        expect(present(withText(`Grep`, ``)).summary).toBe(`no matches`);
    });

    it(`sums +/- across an edit's structured diffs`, () => {
        const result = present(
            tool({
                name: `Edit`,
                category: `edit`,
                content: [{ type: `diff`, path: `a.ts`, oldText: `one\ntwo`, newText: `one\ntwo prime\nthree` }],
            }),
        );
        expect(result.summary).toBe(`+2 −1`);
    });

    it(`gives an edit with no structured diff no summary rather than "+0 −0"`, () => {
        expect(present(tool({ name: `Edit`, category: `edit` })).summary).toBeUndefined();
    });

    it(`says "failed" for a failed call, whatever its presenter would have said`, () => {
        expect(present(withText(`Grep`, `a/b.ts`, { status: `failed` })).summary).toBe(`failed`);
    });

    it(`summarizes a text body from its uncapped length, not the truncated render`, () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${`pad`.repeat(20)}`).join(`\n`);
        expect(lines.length).toBeGreaterThan(TEXT_CAP);
        expect(present(withText(`Read`, lines)).summary).toBe(`500 lines`);
    });
});

describe(`present: fold policy`, () => {
    it(`starts a running call expanded so live output is visible`, () => {
        expect(present(withText(`Bash`, `…`, { status: `in_progress` })).defaultOpen).toBe(true);
        expect(present(withText(`Bash`, `…`, { status: `pending` })).defaultOpen).toBe(true);
    });

    it(`starts a failed call expanded: the error is what the user needs`, () => {
        expect(present(withText(`Bash`, `boom`, { status: `failed` })).defaultOpen).toBe(true);
    });

    it(`starts a settled successful call collapsed so a long turn stays skimmable`, () => {
        expect(present(withText(`Bash`, `ok`, { status: `completed` })).defaultOpen).toBe(false);
    });
});

describe(`present: diffs`, () => {
    it(`hands the structured diffs through and keeps the card foldable even with no text`, () => {
        const result = present(tool({ name: `Write`, category: `edit`, content: [{ type: `diff`, path: `a.ts`, newText: `hello` }] }));
        expect(result.diffs).toEqual([{ type: `diff`, path: `a.ts`, newText: `hello` }]);
        // No text body, but the diffs are content: the card must still offer its fold affordance.
        expect(result.body).toBeUndefined();
    });
});

/* A DOCUMENT IS AN ARTIFACT, NOT AN ACT. A markdown file written whole is the one thing a turn produces that is
 * addressed to the reader, and drawn as a diff stat it was the one thing the transcript would not show. The
 * test the card asks is the contract's (documents.ts), so a document is the same thing on both sides of the
 * wire: what the daemon attaches to a question card is what the write's own card drew. */
describe(`present: documents`, () => {
    const written = (path: string, markdown: string, over: Partial<TranscriptTool> = {}): TranscriptTool =>
        tool({ name: `Write`, category: `edit`, content: [{ type: `diff`, path, newText: markdown }], ...over });

    it(`draws a markdown file written whole as prose, titled by its heading, and not also as its diff`, () => {
        const result = present(written(`docs/findings.md`, `# Why it is slow\n\nThe poll.`));
        expect(result.document).toMatchObject({ path: `docs/findings.md`, title: `Why it is slow` });
        // One or the other, never both: the diff of a whole-file write is every line with a plus in front of it.
        expect(result.diffs).toEqual([]);
    });

    it(`opens by default: a write-up nobody can see is the failure this exists to fix`, () => {
        expect(present(written(`docs/findings.md`, `# Findings`)).defaultOpen).toBe(true);
        expect(present(written(`src/app.ts`, `export const x = 1;`)).defaultOpen).toBe(false);
    });

    it(`wears the plan card's own glyph for a plan file, and the reading one otherwise`, () => {
        expect(present(written(`${PLAN_DOCUMENTS_DIR}/wiggly-spring.md`, `# Plan`)).icon).toBe(`list-check`);
        expect(present(written(`docs/findings.md`, `# Findings`)).icon).toBe(`book`);
        expect(present(written(`src/app.ts`, `code`)).icon).toBe(`file-edit`);
    });

    it(`leaves an EDIT to a document as a diff: the change is what a reader wants from one`, () => {
        const edited = tool({
            name: `Edit`,
            category: `edit`,
            content: [{ type: `diff`, path: `docs/findings.md`, oldText: `old`, newText: `new` }],
        });
        expect(present(edited).document).toBeUndefined();
        expect(present(edited).diffs).toHaveLength(1);
    });

    it(`draws no document for a write that failed: its content is what the agent MEANT to write`, () => {
        const failed = present(written(`docs/findings.md`, `# Findings`, { status: `failed` }));
        expect(failed.document).toBeUndefined();
        expect(failed.diffs).toHaveLength(1);
    });
});
