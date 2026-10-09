import type { TranscriptRow, TranscriptTool } from "../events/transcript.js";
import { fitNestedTool, fitPageRow, PAGE_TEXT_CAP } from "./transcript-page.js";

// What a page carries of a row, which the daemon serves and the editor mirrors: the two have to agree to the byte.

const long = `x`.repeat(PAGE_TEXT_CAP + 500);
const call = (id: string, extra: Partial<TranscriptTool> = {}): TranscriptTool => ({
    id,
    name: `Bash`,
    category: `execute`,
    status: `completed`,
    ...extra,
});

describe(`fitPageRow`, () => {
    it(`hands back a row with no calls as it is`, () => {
        const row: TranscriptRow = { role: `assistant`, text: `done` };
        expect(fitPageRow(row)).toBe(row);
    });

    it(`keeps each output's start and counts a delegation's calls instead of carrying them`, () => {
        const row: TranscriptRow = {
            role: `assistant`,
            text: ``,
            tools: [call(`a`, { content: [{ type: `text`, text: long }] }), call(`b`, { name: `Agent`, children: [call(`c`), call(`d`)] })],
        };
        const fitted = fitPageRow(row);
        expect(fitted.tools?.[0]?.content).toEqual([{ type: `text`, text: long.slice(0, PAGE_TEXT_CAP) }]);
        expect(fitted.tools?.[1]?.children).toBeUndefined();
        expect(fitted.tools?.[1]?.nested).toBe(2);
    });
});

describe(`fitNestedTool`, () => {
    it(`keeps every call under it, each output fitted at every depth`, () => {
        const fitted = fitNestedTool(call(`a`, { children: [call(`b`, { content: [{ type: `text`, text: long }] })] }));
        expect(fitted.children?.[0]?.content).toEqual([{ type: `text`, text: long.slice(0, PAGE_TEXT_CAP) }]);
    });
});
