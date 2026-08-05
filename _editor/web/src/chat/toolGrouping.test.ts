import { describe, expect, it } from "vitest";
import type { ChatTool } from "../composables/chat/transcript";
import { type ToolGroup, groupConsecutiveTools, groupDiffSummary } from "./toolGrouping";

const tool = (name: string, target?: string, id?: string): ChatTool => ({
    id: id ?? `t-${name}-${target ?? "none"}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    category: `edit`,
    status: `completed`,
    target,
});

const editWithDiff = (target: string, additions: number, deletions: number, id?: string): ChatTool => ({
    id: id ?? `t-${Math.random().toString(36).slice(2, 6)}`,
    name: `Edit`,
    category: `edit`,
    status: `completed`,
    target,
    content: [{ type: `diff`, path: target, oldText: `a\n`.repeat(deletions), newText: `b\n`.repeat(additions) }],
});

describe(`groupConsecutiveTools`, () => {
    it(`returns all tools individually when fewer than 3`, () => {
        const tools = [tool(`Edit`, `a.ts`), tool(`Edit`, `a.ts`)];
        expect(groupConsecutiveTools(tools)).toEqual(tools);
    });

    it(`groups 3+ consecutive calls with the same name and target`, () => {
        const tools = [tool(`Edit`, `a.ts`, `t1`), tool(`Edit`, `a.ts`, `t2`), tool(`Edit`, `a.ts`, `t3`)];
        const result = groupConsecutiveTools(tools);
        expect(result).toHaveLength(1);
        const group = result[0] as ToolGroup;
        expect(group.kind).toBe(`group`);
        expect(group.name).toBe(`Edit`);
        expect(group.target).toBe(`a.ts`);
        expect(group.tools).toHaveLength(3);
    });

    it(`keeps different targets as separate entries`, () => {
        const tools = [tool(`Edit`, `a.ts`, `t1`), tool(`Edit`, `b.ts`, `t2`), tool(`Edit`, `c.ts`, `t3`)];
        const result = groupConsecutiveTools(tools);
        expect(result).toHaveLength(3);
        expect(result.every((entry) => !(`kind` in entry))).toBe(true);
    });

    it(`breaks a run when the target changes`, () => {
        const tools = [
            tool(`Edit`, `a.ts`, `t1`),
            tool(`Edit`, `a.ts`, `t2`),
            tool(`Edit`, `a.ts`, `t3`),
            tool(`Edit`, `b.ts`, `t4`),
            tool(`Edit`, `a.ts`, `t5`),
        ];
        const result = groupConsecutiveTools(tools);
        // First 3 group, then 1 single, then 1 single.
        expect(result).toHaveLength(3);
        expect((result[0] as ToolGroup).tools).toHaveLength(3);
    });

    it(`breaks a run when the name changes`, () => {
        const tools = [
            tool(`Edit`, `a.ts`, `t1`),
            tool(`Edit`, `a.ts`, `t2`),
            tool(`Edit`, `a.ts`, `t3`),
            tool(`Read`, `a.ts`, `t4`),
        ];
        const result = groupConsecutiveTools(tools);
        expect(result).toHaveLength(2);
        expect((result[0] as ToolGroup).tools).toHaveLength(3);
        expect((result[1] as ChatTool).name).toBe(`Read`);
    });

    it(`produces multiple groups in one tool list`, () => {
        const tools = [
            tool(`Edit`, `a.ts`, `t1`),
            tool(`Edit`, `a.ts`, `t2`),
            tool(`Edit`, `a.ts`, `t3`),
            tool(`Read`, `x.ts`, `t4`),
            tool(`Edit`, `b.ts`, `t5`),
            tool(`Edit`, `b.ts`, `t6`),
            tool(`Edit`, `b.ts`, `t7`),
            tool(`Edit`, `b.ts`, `t8`),
        ];
        const result = groupConsecutiveTools(tools);
        expect(result).toHaveLength(3);
        expect((result[0] as ToolGroup).tools).toHaveLength(3);
        expect((result[1] as ChatTool).name).toBe(`Read`);
        expect((result[2] as ToolGroup).tools).toHaveLength(4);
    });

    it(`handles an empty tool list`, () => {
        expect(groupConsecutiveTools([])).toEqual([]);
    });

    it(`passes a single tool through unchanged`, () => {
        const tools = [tool(`Edit`, `a.ts`)];
        expect(groupConsecutiveTools(tools)).toEqual(tools);
    });

    it(`groups tools with no target (undefined) together`, () => {
        const tools = [tool(`Bash`, undefined, `t1`), tool(`Bash`, undefined, `t2`), tool(`Bash`, undefined, `t3`)];
        const result = groupConsecutiveTools(tools);
        expect(result).toHaveLength(1);
        expect((result[0] as ToolGroup).target).toBeUndefined();
    });
});

describe(`groupDiffSummary`, () => {
    it(`aggregates additions and deletions across tools`, () => {
        const tools = [editWithDiff(`a.ts`, 3, 1), editWithDiff(`a.ts`, 2, 2)];
        expect(groupDiffSummary(tools)).toBe(`+5 −3`);
    });

    it(`returns undefined when no tool carries diffs`, () => {
        expect(groupDiffSummary([tool(`Read`, `a.ts`)])).toBeUndefined();
    });
});
