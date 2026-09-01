/* THE COMPOSER ROW'S ONE RULE, asserted as a table: a control is in the row when it is doing something to the
 * next send, and in the overflow when it is not. Written here rather than against a mounted pane because the
 * rule is the thing worth pinning, and because the two halves must never both be true, which is a property of
 * the table and not of any component that draws it. */
import { expect, it } from "vitest";
import { type ComposerControlSituation, CONTROL_ORDER, overflowRows, ridesRow } from "./composerMore";

// An ordinary isolated chat that has run a turn: nothing set, everything offered.
const PLAIN: ComposerControlSituation = {
    mode: `bypassPermissions`,
    startingMode: `bypassPermissions`,
    persona: undefined,
    runThrough: `idle`,
    voiceAgent: false,
    personaOffered: true,
    voiceOffered: true,
};
const chat = (state: Partial<ComposerControlSituation>): ComposerControlSituation => ({ ...PLAIN, ...state });
const keys = (situation: ComposerControlSituation): string[] => overflowRows(situation).map((row) => row.key);

it(`keeps an ordinary chat's row empty and offers all four in the overflow`, () => {
    expect(ridesRow(PLAIN)).toEqual({ mode: false, persona: false, runThrough: false, voice: false });
    expect(keys(PLAIN)).toEqual([`mode`, `persona`, `runThrough`, `voice`]);
});

it(`promotes each control into the row the moment it is set`, () => {
    expect(ridesRow(chat({ mode: `plan` })).mode).toBe(true);
    expect(ridesRow(chat({ persona: `ada` })).persona).toBe(true);
    expect(ridesRow(chat({ runThrough: `workflow` })).runThrough).toBe(true);
    expect(ridesRow(chat({ voiceAgent: true })).voice).toBe(true);
});

/* THE INVARIANT THE WHOLE THING RESTS ON. A control in both places is two entry points to one choice, and a
 * control in neither is a feature the app has quietly stopped offering: either would be the bug this rule is
 * most likely to grow. */
it(`puts every offered control in exactly one of the two places`, () => {
    const situations = [
        PLAIN,
        chat({ mode: `plan` }),
        chat({ persona: `ada`, voiceAgent: true }),
        chat({ mode: `plan`, persona: `ada`, runThrough: `running`, voiceAgent: true }),
    ];
    for (const situation of situations) {
        const row = ridesRow(situation);
        const menu = new Set(keys(situation));
        for (const control of CONTROL_ORDER) {
            expect(row[control] && menu.has(control)).toBe(false);
            expect(row[control] || menu.has(control)).toBe(true);
        }
    }
});

/* A chat's default posture is its own, not a constant: an isolated chat runs unattended and a main-tree one
 * plans first (turnDefaults.startingMode), so the same mode is unremarkable on one and worth a chip on the
 * other. Comparing against one hard-coded mode would put a permanent chip on every chat of one kind. */
it(`reads the mode against this chat's own default, not a fixed one`, () => {
    expect(ridesRow(chat({ mode: `plan`, startingMode: `plan` })).mode).toBe(false);
    expect(ridesRow(chat({ mode: `bypassPermissions`, startingMode: `plan` })).mode).toBe(true);
});

// A running loop is set, so its badge stays in the row: that badge is also the loop's stop, and a stop behind a
// menu would leave a loop spending with no way out but the fleet board.
it(`keeps a running loop in the row`, () => {
    expect(ridesRow(chat({ runThrough: `running` })).runThrough).toBe(true);
    expect(keys(chat({ runThrough: `running` }))).not.toContain(`runThrough`);
});

// A control this chat cannot have is in neither place: personas are one daemon's cards, and there is nothing to
// place into until the chat has a transcript.
it(`drops the controls this chat is not offered`, () => {
    const away = chat({ personaOffered: false, voiceOffered: false });
    expect(ridesRow(away)).toEqual({ mode: false, persona: false, runThrough: false, voice: false });
    expect(keys(away)).toEqual([`mode`, `runThrough`]);
    // …and a persona set before the chat moved to another sandbox still doesn't get a chip: the send drops it.
    expect(ridesRow(chat({ personaOffered: false, persona: `ada` })).persona).toBe(false);
});

it(`carries the current value and a sentence on every overflow row`, () => {
    const rows = overflowRows(PLAIN);
    expect(rows.map((row) => row.label)).toEqual([`Agent mode`, `Acts as`, `Run through`, `Write as agent`]);
    expect(rows.map((row) => row.value)).toEqual([`Auto`, `Anyone`, `Just this chat`, `Off`]);
    expect(rows.every((row) => row.description.length > 0)).toBe(true);
    // The mode row names the posture this chat is actually in, so a main-tree chat's menu doesn't say "Auto".
    expect(overflowRows(chat({ mode: `plan`, startingMode: `plan` }))[0]?.value).toBe(`Plan`);
});
