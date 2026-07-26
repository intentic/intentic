import { describe, expect, it } from "vitest";
import type { ChatTool } from "../composables/chat/conversation";
import { present, TEXT_CAP } from "./toolPresentation";

// A completed call with no output, spread over per-case.
const tool = (over: Partial<ChatTool> & Pick<ChatTool, "name">): ChatTool => ({
    id: `t1`,
    category: `other`,
    status: `completed`,
    ...over,
});

const withText = (name: string, text: string, over: Partial<ChatTool> = {}): ChatTool => tool({ name, content: [{ type: `text`, text }], ...over });

describe(`present: icons`, () => {
    it(`falls back to the ACP category when no presenter claims the name`, () => {
        expect(present(tool({ name: `mcp__db__query`, category: `search` })).icon).toBe(`search`);
        expect(present(tool({ name: `Whatever`, category: `other` })).icon).toBe(`angle-right`);
    });

    it(`lets a per-name presenter override the category icon`, () => {
        // Task categorizes as `other` (icon angle-right) but reads as a delegation.
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

    it(`keeps a Bash body even when the command printed nothing — the command line is the point`, () => {
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

    it(`starts a failed call expanded — the error is what the user needs`, () => {
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
        // No text body, but the diffs are content — the card must still offer its fold affordance.
        expect(result.body).toBeUndefined();
    });
});
