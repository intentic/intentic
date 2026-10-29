// The composer row's one rule, asserted as a table: a control rides the row when it affects the next
// send, otherwise it's in the overflow. Pinned here, not against a mounted pane, since the two halves
// must never both be true.
import { type ComposerControlSituation, CONTROL_ORDER, DESCRIPTION_LIMIT, overflowRows, ridesRow } from "./composerMore";

// An ordinary isolated chat that has run a turn: nothing set, everything offered.
const PLAIN: ComposerControlSituation = {
    mode: `bypassPermissions`,
    startingMode: `bypassPermissions`,
    placementOffered: true,
    placed: false,
    persona: undefined,
    runThrough: `idle`,
    voiceAgent: false,
    personaOffered: true,
    voiceOffered: true,
    landOffered: true,
    lands: false,
    landOwn: false,
};
const chat = (state: Partial<ComposerControlSituation>): ComposerControlSituation => ({ ...PLAIN, ...state });
const keys = (situation: ComposerControlSituation): string[] => overflowRows(situation).map((row) => row.key);

// When the message goes is not among them: it is the send's own caret, beside the press it changes (ChatPane).
it(`keeps an ordinary chat's row empty and offers all six in the overflow`, () => {
    expect(ridesRow(PLAIN)).toEqual({ mode: false, placement: false, startFrom: false, persona: false, runThrough: false, voice: false, land: false });
    expect(keys(PLAIN)).toEqual([`mode`, `placement`, `persona`, `runThrough`, `voice`, `land`]);
});

it(`promotes each control into the row the moment it is set`, () => {
    expect(ridesRow(chat({ mode: `plan` })).mode).toBe(true);
    expect(ridesRow(chat({ placed: true })).placement).toBe(true);
    expect(ridesRow(chat({ persona: `ada` })).persona).toBe(true);
    expect(ridesRow(chat({ runThrough: `workflow` })).runThrough).toBe(true);
    expect(ridesRow(chat({ voiceAgent: true })).voice).toBe(true);
    expect(ridesRow(chat({ landOwn: true, lands: true })).land).toBe(true);
});

// Whether work lands by itself rides the row only as the chat's own answer: following the sandbox's, on or off, is
// the default, and the overflow row says which way it reads.
it(`keeps landing in the overflow while it follows the sandbox, worded by which way that is`, () => {
    expect(ridesRow(chat({ lands: true })).land).toBe(false);
    const holding = overflowRows(PLAIN).find((row) => row.key === `land`);
    expect(holding).toMatchObject({ value: `Off`, description: `Its finished work lands by itself.` });
    const landing = overflowRows(chat({ lands: true })).find((row) => row.key === `land`);
    expect(landing).toMatchObject({ value: `On`, description: `Hold its finished work on the branch.` });
});

// A control in both places is two entry points to one choice; in neither, a feature quietly stopped
// offering itself. Either is the likely bug.
it(`puts every offered control in exactly one of the two places`, () => {
    const situations = [
        PLAIN,
        chat({ mode: `plan` }),
        chat({ placed: true }),
        chat({ persona: `ada`, voiceAgent: true }),
        chat({ mode: `plan`, placed: true, persona: `ada`, runThrough: `running`, voiceAgent: true }),
        chat({ landOwn: true, lands: true }),
        chat({ startOffered: true }),
        chat({ startOffered: true, startSet: true }),
    ];
    for (const situation of situations) {
        const row = ridesRow(situation);
        const menu = new Set(keys(situation));
        // Where it starts from is offered only to a draft (the two `startOffered` cases); a chat that ran a turn has none.
        for (const control of CONTROL_ORDER.filter((each) => each !== `startFrom` || situation.startOffered === true)) {
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

// Where the chat runs rides the row only once it is somewhere else: a chat in another box or on a runner must never be
// out of sight, while "this sandbox" is the default and waits in the overflow like the rest.
it(`keeps where the chat runs in the overflow while it is here, and on the row once it is placed elsewhere`, () => {
    expect(keys(PLAIN)).toContain(`placement`);
    expect(ridesRow(PLAIN).placement).toBe(false);

    expect(ridesRow(chat({ placed: true })).placement).toBe(true);
    expect(keys(chat({ placed: true }))).not.toContain(`placement`);
    // With nowhere else to run and nothing placed, there is nothing to say.
    expect(keys(chat({ placementOffered: false }))).not.toContain(`placement`);
});

// Where a new agent starts is a draft's to choose, and only on a private copy here: at the main line it waits in the
// overflow, named by the branch the shared workspace stands on; a branch or another agent's copy rides the row.
it(`offers a draft where it starts from in the overflow, and rides the row once it starts from a branch or a copy`, () => {
    const draft = chat({ startOffered: true, mainLine: `main` });
    expect(keys(draft)).toEqual([`mode`, `placement`, `startFrom`, `persona`, `runThrough`, `voice`, `land`]);
    expect(overflowRows(draft).find((row) => row.key === `startFrom`)).toMatchObject({ label: `Start from`, value: `main`, icon: `git-branch` });
    expect(ridesRow(draft).startFrom).toBe(false);

    const onBranch = chat({ startOffered: true, startSet: true });
    expect(ridesRow(onBranch).startFrom).toBe(true);
    expect(keys(onBranch)).not.toContain(`startFrom`);
    // Once the first turn is taken, or for a chat elsewhere, the start is the card's to say: in neither place.
    expect(keys(chat({ startOffered: false, startSet: true }))).not.toContain(`startFrom`);
    expect(ridesRow(chat({ startOffered: false, startSet: true })).startFrom).toBe(false);
    // Without the main line's name it still says where it starts.
    expect(overflowRows(chat({ startOffered: true })).find((row) => row.key === `startFrom`)?.value).toBe(`Main line`);
    expect(keys(chat({ startOffered: true, plain: true }))).toEqual([`mode`]);
});

// A control this chat can't have is in neither place: personas are one daemon's personas, voice needs a
// transcript.
it(`drops the controls this chat is not offered`, () => {
    const away = chat({ placementOffered: false, personaOffered: false, voiceOffered: false, landOffered: false });
    expect(ridesRow(away)).toEqual({ mode: false, placement: false, startFrom: false, persona: false, runThrough: false, voice: false, land: false });
    expect(keys(away)).toEqual([`mode`, `runThrough`]);
    // An answer given before the chat stopped being this reader's to land gets no chip either.
    expect(ridesRow(chat({ landOffered: false, landOwn: true })).land).toBe(false);
    // A persona set before the chat moved sandboxes still gets no chip: the send drops it.
    expect(ridesRow(chat({ personaOffered: false, persona: `ada` })).persona).toBe(false);
});

it(`carries the current value and a sentence on every overflow row`, () => {
    const rows = overflowRows(PLAIN);
    expect(rows.map((row) => row.label)).toEqual([`Agent mode`, `Where this runs`, `Acts as`, `Run through`, `Write as agent`, `Land when done`]);
    expect(rows.map((row) => row.value)).toEqual([`Auto`, `This sandbox`, `Full access`, `Just this chat`, `Off`, `Off`]);
    expect(rows.every((row) => row.description.length > 0)).toBe(true);
    // The mode row names the posture this chat is actually in, so a main-tree chat's menu doesn't say "Auto".
    expect(overflowRows(chat({ mode: `plan`, startingMode: `plan` }))[0]?.value).toBe(`Plan`);
});

// Asserted, not trusted: descriptions are literals a few lines apart, so only a failing check keeps
// them short. Checked across every mode.
it(`keeps every description to a single line`, () => {
    const modes = [`default`, `plan`, `bypassPermissions`] as const;
    for (const mode of modes) {
        for (const row of overflowRows(chat({ mode, startingMode: mode, startOffered: true }))) {
            expect(row.description.length, `${row.label}: "${row.description}"`).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
        }
    }
});

// Model and effort have their own controls in either audience, so plain words need no second model entry here.
it(`offers a non-coder only how much it does alone in the overflow`, () => {
    const plain = chat({ plain: true });
    expect(keys(plain)).toEqual([`mode`]);
    expect(overflowRows(plain)).toEqual([{
        key: `mode`, icon: `forward`, label: `How much it does on its own`, value: `Auto`, description: `When it stops to ask you first.`,
    }]);
    expect(Object.values(ridesRow(plain)).some(Boolean)).toBe(false);
});

it(`offers a guest nothing at all, in either place`, () => {
    const guest = chat({ guest: true, mode: `plan`, persona: `ada` });
    expect(keys(guest)).toEqual([]);
    expect(Object.values(ridesRow(guest)).some(Boolean)).toBe(false);
});

it(`keeps the developer's menu exactly as it was`, () => {
    expect(keys(chat({ plain: false }))).toEqual(keys(PLAIN));
    expect(keys(PLAIN)).not.toContain(`model`);
});
