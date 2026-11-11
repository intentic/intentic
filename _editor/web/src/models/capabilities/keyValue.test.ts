import { keyNameValid, keyValueText, parseKeyValues, pastedRows } from "./keyValue";

// A `keyValue` field's rows store exactly the `KEY=VALUE` text the textarea it replaces held, read the way the sandbox
// reads it (runtimes/acp/acp-spawn.ts), so a card switched to rows changes nothing downstream.

test(`reads a block the way the sandbox does, and writes the rows back as the same lines`, () => {
    const block = `# keys\nGEMINI_API_KEY=abc=def\n\n  PROXY = http://p:3128 \nnot a pair\n=orphan`;

    expect(parseKeyValues(block)).toEqual([
        { name: `GEMINI_API_KEY`, value: `abc=def` },
        { name: `PROXY`, value: `http://p:3128` },
    ]);
    expect(keyValueText(parseKeyValues(block))).toBe(`GEMINI_API_KEY=abc=def\nPROXY=http://p:3128`);
    expect(parseKeyValues(undefined)).toEqual([]);
});

test(`stores no line for a row without a name, and an empty value as an empty one`, () => {
    expect(
        keyValueText([
            { name: ``, value: `stray` },
            { name: ` A `, value: `` },
            { name: `B`, value: ` 2 ` },
        ]),
    ).toBe(`A=\nB=2`);
});

test(`refuses a name a shell could not set, never an empty one`, () => {
    expect(keyNameValid(`OPENAI_API_KEY`)).toBe(true);
    expect(keyNameValid(``)).toBe(true);
    expect(keyNameValid(`2FA`)).toBe(false);
    expect(keyNameValid(`MY-KEY`)).toBe(false);
});

test(`reads a pasted .env or export line as rows, and leaves a pasted name alone`, () => {
    expect(pastedRows(`export A=1\nB=2`)).toEqual([
        { name: `A`, value: `1` },
        { name: `B`, value: `2` },
    ]);
    expect(pastedRows(`OPENAI_API_KEY`)).toBeUndefined();
    expect(pastedRows(`just words\nmore words`)).toBeUndefined();
});
