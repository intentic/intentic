import type { ChatMessage } from "./transcript";
import { settledMirror } from "./transcriptCache";

// Pins what the mirror keeps while a run is still going: none of that run's rows, from this window or from what the
// mirror already held, so a reopen never paints a moment of a live run as now.

const SETTLED: readonly ChatMessage[] = [
    { id: 1, role: `user`, text: `map the routes`, run: `r1`, at: 0, rowId: `a` },
    { id: 2, role: `assistant`, text: `mapped`, run: `r1`, at: 1, rowId: `b` },
];
const LIVE: readonly ChatMessage[] = [
    { id: 3, role: `user`, text: `start the demo`, run: `r2`, rowId: `c` },
    {
        id: 4,
        role: `assistant`,
        text: ``,
        run: `r2`,
        rowId: `d`,
        tools: [{ id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `preview demo`, startedAt: 1 }],
    },
];

const texts = (messages: readonly ChatMessage[]): string[] => messages.map((message) => message.text);

describe(`settledMirror`, () => {
    it(`leaves the open run's rows out of what this window writes`, () => {
        expect(texts(settledMirror([...SETTLED, ...LIVE], undefined, true, `r2`))).toEqual([`map the routes`, `mapped`]);
    });

    it(`takes the open run's rows out of a longer mirror an unconfirmed write may not shrink`, () => {
        const held = [...SETTLED, { id: 9, role: `assistant` as const, text: `older note`, run: `r0` }, ...LIVE];
        expect(texts(settledMirror(SETTLED, held, false, `r2`))).toEqual([`map the routes`, `mapped`, `older note`]);
    });

    it(`writes this window's rows when they hold more than the mirror does`, () => {
        expect(texts(settledMirror([...SETTLED, ...LIVE], [...LIVE], false, `r2`))).toEqual([`map the routes`, `mapped`]);
    });

    it(`is empty when the open run is all there is, as a subagent's only turn is`, () => {
        expect(settledMirror(LIVE, LIVE, false, `r2`)).toEqual([]);
    });
});
