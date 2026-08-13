import { describe, expect, it } from "vitest";
import type { ChatTool } from "../composables/chat/transcript";
import { summarizeRun } from "./toolRun";

let next = 0;
const tool = (over: Partial<ChatTool> & Pick<ChatTool, "category">): ChatTool => ({
    id: `t${(next += 1)}`,
    name: `Tool`,
    status: `completed`,
    ...over,
});

const read = (): ChatTool => tool({ category: `read`, name: `Read`, target: `a.ts` });
const search = (): ChatTool => tool({ category: `search`, name: `Grep`, target: `foo` });
const run = (): ChatTool => tool({ category: `execute`, name: `Bash`, target: `pnpm test` });
const edit = (): ChatTool => tool({ category: `edit`, name: `Edit`, target: `a.ts` });

describe(`summarizeRun`, () => {
    it(`counts the calls the mark stands in for`, () => {
        expect(summarizeRun([read(), search(), run()])?.count).toBe(3);
    });

    it(`has nothing to show for a turn that made no calls`, () => {
        expect(summarizeRun([])).toBeUndefined();
    });

    it(`wears the mark of the most consequential call, not the commonest`, () => {
        // Six reads and one edit: the edit is what happened.
        const tools = [read(), read(), read(), edit(), read(), read(), read()];
        expect(summarizeRun(tools)?.icon).toBe(`file-edit`);
    });

    it(`ranks a delegation above everything it could have done itself`, () => {
        const delegation = tool({ category: `other`, name: `Agent`, children: [edit()] });
        expect(summarizeRun([edit(), delegation, run()])?.icon).toBe(`users`);
    });

    it(`ranks a picture that came back above the commands around it`, () => {
        const shot = tool({ category: `other`, name: `Browser take screenshot`, content: [{ type: `image`, path: `shot.png` }] });
        expect(summarizeRun([run(), shot, read()])?.icon).toBe(`globe`);
    });

    it(`treats a shell call that carried a diff as a change, whatever its category says`, () => {
        const wrote = tool({ category: `execute`, name: `Bash`, content: [{ type: `diff`, path: `a.ts`, newText: `x` }] });
        expect(summarizeRun([read(), wrote])?.icon).toBe(`code`);
        // …and outranks the plain commands beside it, so the mark is the one that changed something.
        expect(summarizeRun([wrote, run()])?.icon).toBe(`code`);
    });

    it(`falls back through commands, searches and reads when nothing changed`, () => {
        expect(summarizeRun([read(), search(), run()])?.icon).toBe(`code`);
        expect(summarizeRun([read(), search()])?.icon).toBe(`search`);
        expect(summarizeRun([read()])?.icon).toBe(`file`);
    });

    it(`keeps its face while equally notable calls land behind it`, () => {
        const first = tool({ category: `edit`, name: `Edit`, target: `a.ts` });
        expect(summarizeRun([first, edit(), edit()])?.icon).toBe(summarizeRun([first])?.icon);
    });

    it(`reports a failure and a call still in flight`, () => {
        expect(summarizeRun([read(), tool({ category: `execute`, name: `Bash`, status: `failed` })])?.failed).toBe(true);
        expect(summarizeRun([read(), tool({ category: `execute`, name: `Bash`, status: `in_progress` })])?.running).toBe(true);
        expect(summarizeRun([read(), run()])?.failed).toBe(false);
        expect(summarizeRun([read(), run()])?.running).toBe(false);
    });
});
