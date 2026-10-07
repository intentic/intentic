// Pins what the scratch pad's header says a conversation is at: the last words someone said, as plain text.
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { lastWords, plainWords } from "./lastWords";

const rows = (...list: unknown[]): TranscriptRow[] => list as TranscriptRow[];

it(`reads markdown as the words a reader would see`, () => {
    expect(plainWords(`## Plan\n\n- **one** step\n- a [link](https://x.y)\n\n\`\`\`ts\nconst code = 1;\n\`\`\`\nthen \`done\``)).toBe(
        `Plan one step a link then done`,
    );
});

it(`takes the newest row with words, from either side`, () => {
    expect(lastWords(rows({ role: `assistant`, text: `first` }, { role: `user`, text: `second` }))).toEqual({ who: `you`, text: `second` });
    expect(lastWords(rows({ role: `user`, text: `ask` }, { role: `assistant`, text: `answer` }))).toEqual({ who: `agent`, text: `answer` });
});

it(`skips rows that carry no words: a tool call, an empty ask, a notice`, () => {
    expect(
        lastWords(
            rows(
                { role: `assistant`, text: `the reply` },
                { role: `assistant`, text: ``, permission: { requestId: `p`, toolName: `Bash`, status: `pending` } },
                { role: `system`, text: `a notice` },
            ),
        ),
    ).toEqual({ who: `agent`, text: `the reply` });
});

it(`reads a plan by its own text`, () => {
    expect(lastWords(rows({ role: `assistant`, text: ``, plan: { text: `1. Add the **route**` } }))).toEqual({ who: `agent`, text: `Add the route` });
});

it(`has nothing to say for a conversation nobody has spoken in`, () => {
    expect(lastWords([])).toBeUndefined();
});
