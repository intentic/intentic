// The composer row's one rule, asserted as a table: a control rides the row when it affects the next
// send, otherwise it's in the overflow. Pinned here, not against a mounted pane, since the two halves
// must never both be true.
import { expect, it } from "vitest";
import { type ComposerControlSituation, CONTROL_ORDER, DESCRIPTION_LIMIT, overflowRows, ridesRow } from "./composerMore";

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

// A control in both places is two entry points to one choice; in neither, a feature quietly stopped
// offering itself. Either is the likely bug.
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

// A chat's default posture is its own, not a constant (isolated runs unattended, main-tree plans
// first), so the same mode can be unremarkable on one and a chip on the other.
it(`reads the mode against this chat's own default, not a fixed one`, () => {
    expect(ridesRow(chat({ mode: `plan`, startingMode: `plan` })).mode).toBe(false);
    expect(ridesRow(chat({ mode: `bypassPermissions`, startingMode: `plan` })).mode).toBe(true);
});

// A running loop's badge stays in the row: it's also the stop, with no other way out but the fleet board.
it(`keeps a running loop in the row`, () => {
    expect(ridesRow(chat({ runThrough: `running` })).runThrough).toBe(true);
    expect(keys(chat({ runThrough: `running` }))).not.toContain(`runThrough`);
});

// A control this chat can't have is in neither place: personas are one daemon's cards, voice needs a
// transcript.
it(`drops the controls this chat is not offered`, () => {
    const away = chat({ personaOffered: false, voiceOffered: false });
    expect(ridesRow(away)).toEqual({ mode: false, persona: false, runThrough: false, voice: false });
    expect(keys(away)).toEqual([`mode`, `runThrough`]);
    // A persona set before the chat moved sandboxes still gets no chip: the send drops it.
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

// Asserted, not trusted: descriptions are literals a few lines apart, so only a failing check keeps
// them short. Checked across every mode.
it(`keeps every description to a single line`, () => {
    const modes = [`default`, `acceptEdits`, `plan`, `bypassPermissions`] as const;
    for (const mode of modes) {
        for (const row of overflowRows(chat({ mode, startingMode: mode }))) {
            expect(row.description.length, `${row.label}: "${row.description}"`).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
        }
    }
});
