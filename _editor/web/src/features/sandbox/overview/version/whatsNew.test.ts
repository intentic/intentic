import { noteLines } from "./whatsNew";

it(`splits a note at its semicolon into the change and what it replaced, the second a sentence of its own`, () => {
    expect(
        noteLines(`Approve or reject a waiting plan from the bar above the composer; those buttons no longer appear on the plan card in the transcript.`),
    ).toEqual({
        head: `Approve or reject a waiting plan from the bar above the composer`,
        detail: `Those buttons no longer appear on the plan card in the transcript.`,
    });
});

it(`keeps a one-thought note whole, without the full stop that would end it mid-list`, () => {
    expect(noteLines(`Desktop sign-in completes successfully again instead of showing an incomplete sign-in link.`)).toEqual({
        head: `Desktop sign-in completes successfully again instead of showing an incomplete sign-in link`,
        detail: undefined,
    });
});

it(`leaves a semicolon alone when either side is too short to stand as a line`, () => {
    expect(noteLines(`Fix: a; b and c and d and e.`)).toEqual({ head: `Fix: a; b and c and d and e`, detail: undefined });
    expect(noteLines(`Terminals reconnect after a sleep; faster.`)).toEqual({ head: `Terminals reconnect after a sleep; faster`, detail: undefined });
});

it(`keeps the spelling of a detail that opens on a name rather than an ordinary word`, () => {
    expect(noteLines(`The desktop app installs Docker for you; macOS asks for your password once.`).detail).toBe(`macOS asks for your password once.`);
    expect(noteLines(`Updates run through the command line tool; \`ic\` prints what it changed.`).detail).toBe(`\`ic\` prints what it changed.`);
});

it(`keeps an ellipsis, which is not a full stop`, () => {
    expect(noteLines(`Long transcripts load as you scroll...`).head).toBe(`Long transcripts load as you scroll...`);
});
