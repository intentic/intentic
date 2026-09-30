import type { TranscriptTool } from "@intentic/sandbox-contract";
import { summarizeRun } from "./toolRun";

let next = 0;
const tool = (over: Partial<TranscriptTool> & Pick<TranscriptTool, "category">): TranscriptTool => ({
    id: `t${(next += 1)}`,
    name: `Tool`,
    status: `completed`,
    ...over,
});

const read = (): TranscriptTool => tool({ category: `read`, name: `Read`, target: `a.ts` });
const search = (): TranscriptTool => tool({ category: `search`, name: `Grep`, target: `foo` });
const run = (): TranscriptTool => tool({ category: `execute`, name: `Bash`, target: `pnpm test` });
const edit = (): TranscriptTool => tool({ category: `edit`, name: `Edit`, target: `a.ts` });

describe(`summarizeRun`, () => {
    it(`counts the calls the node stands in for`, () => {
        expect(summarizeRun([read(), search(), run()])?.count).toBe(3);
    });

    it(`has nothing to show for a turn that made no calls`, () => {
        expect(summarizeRun([])).toBeUndefined();
    });

    it(`breaks the count into kinds, what changed things first and what only looked last`, () => {
        const kinds = summarizeRun([read(), read(), run(), edit(), search(), read()])?.kinds;
        expect(kinds).toEqual([
            { kind: `edits`, count: 1 },
            { kind: `commands`, count: 1 },
            { kind: `searches`, count: 1 },
            { kind: `reads`, count: 3 },
        ]);
    });

    it(`counts a delegation as one subagent call, however much it did itself`, () => {
        const delegation = tool({ category: `other`, name: `Agent`, children: [edit(), edit()] });
        // A transcript page carries the count of a delegation's calls, not the calls.
        const paged = tool({ category: `other`, name: `Agent`, nested: 4 });
        expect(summarizeRun([delegation, paged, run()])?.kinds).toEqual([
            { kind: `subagents`, count: 2 },
            { kind: `commands`, count: 1 },
        ]);
    });

    it(`files a browser tool and a fetch under the web, whatever the backend called them`, () => {
        const shot = tool({ category: `other`, name: `Browser take screenshot`, content: [{ type: `image`, path: `shot.png` }] });
        const fetched = tool({ category: `fetch`, name: `WebFetch` });
        expect(summarizeRun([shot, fetched])?.kinds).toEqual([{ kind: `web`, count: 2 }]);
    });

    it(`treats a shell call that carried a diff as a change, whatever its category says`, () => {
        const wrote = tool({ category: `execute`, name: `Bash`, content: [{ type: `diff`, path: `a.ts`, newText: `x` }] });
        expect(summarizeRun([wrote])?.kinds).toEqual([{ kind: `edits`, count: 1 }]);
    });

    it(`counts the failures and reports a call still in flight`, () => {
        const failed = (): TranscriptTool => tool({ category: `execute`, name: `Bash`, status: `failed` });
        expect(summarizeRun([read(), failed(), failed()])?.failed).toBe(2);
        expect(summarizeRun([read(), tool({ category: `execute`, name: `Bash`, status: `in_progress` })])?.running).toBe(true);
        expect(summarizeRun([read(), run()])?.failed).toBe(0);
        expect(summarizeRun([read(), run()])?.running).toBe(false);
    });
});
