import type { AgentReaction } from "@intentic/sandbox-contract";
import { PICKER_EMOJI, QUICK_EMOJI, reactionChips, withPress } from "./reactions";

const reader = { me: `ada@example.com`, you: `you` };

const marked = (...by: { email: string; name?: string }[]): AgentReaction[] => [
    { emoji: `👍`, by: by.map((who, index) => ({ ...who, at: 1_000 + index })) },
];

describe(`reactionChips`, () => {
    it(`counts the people behind a mark and names them for the hover`, () => {
        const [chip] = reactionChips(marked({ email: `bob@example.com`, name: `Bob` }, { email: `cleo@example.com`, name: `Cleo` }), reader);
        expect(chip).toMatchObject({ emoji: `👍`, count: 2, mine: false, who: `Bob, Cleo` });
    });

    it(`calls the reader "you" rather than making them recognize their own address in a list`, () => {
        const [chip] = reactionChips(marked({ email: `bob@example.com`, name: `Bob` }, { email: `ada@example.com`, name: `Ada` }), reader);
        expect(chip?.who).toBe(`Bob, you`);
        expect(chip?.mine).toBe(true);
    });

    // The same person reaches a sandbox capitalized from one sign-in and lowercase from another; a chip that then
    // failed to light is a chip they would press a second time.
    it(`lights for the reader whatever case their address arrives in`, () => {
        const [chip] = reactionChips(marked({ email: `Ada@Example.com` }), reader);
        expect(chip?.mine).toBe(true);
        expect(chip?.who).toBe(`you`);
    });

    it(`falls back to the address for somebody whose sign-in carried no name`, () => {
        const [chip] = reactionChips(marked({ email: `bob@example.com` }), reader);
        expect(chip?.who).toBe(`bob@example.com`);
    });

    // Nobody signed in yet (a session still being established): the chips still count, they just belong to nobody.
    it(`claims nothing for a reader with no address of their own`, () => {
        const [chip] = reactionChips(marked({ email: `bob@example.com` }), { me: undefined, you: `you` });
        expect(chip?.mine).toBe(false);
        expect(chip?.who).toBe(`bob@example.com`);
    });

    it(`cuts the names at a readable length while the count stays exact`, () => {
        const crowd = Array.from({ length: 30 }, (_, index) => ({ email: `p${index}@example.com`, name: `P${index}` }));
        const [chip] = reactionChips(marked(...crowd), reader);
        expect(chip?.count).toBe(30);
        expect(chip?.who.endsWith(`+6`)).toBe(true);
        expect(chip?.who.split(`, `)).toHaveLength(24);
    });

    it(`draws nothing for a card nobody has marked`, () => {
        expect(reactionChips(undefined, reader)).toEqual([]);
        expect(reactionChips([], reader)).toEqual([]);
    });

    // The quick picks are the row you see without opening anything, so they have to be in the grid the picker opens
    // too, or pressing "another" would offer fewer marks than the row already showed.
    it(`offers the quick picks inside the picker as well`, () => {
        expect(PICKER_EMOJI).toEqual(expect.arrayContaining([...QUICK_EMOJI]));
        expect(new Set(PICKER_EMOJI).size).toBe(PICKER_EMOJI.length);
    });
});

// A mark drawn on the press, before the daemon's answer: it must read exactly as that answer will, so the handover
// changes nothing on screen: the reader added to the end of a mark's wearers, or taken off it, the chip going with
// its last wearer as the wire's does.
describe(`withPress`, () => {
    const me = { email: `ada@example.com`, at: 5_000 };
    const bob = { email: `bob@example.com`, name: `Bob`, at: 1_000 };

    it(`adds the reader to a mark somebody already wears, after them`, () => {
        expect(withPress([{ emoji: `👍`, by: [bob] }], { emoji: `👍`, on: true }, me)).toEqual([{ emoji: `👍`, by: [bob, me] }]);
    });

    it(`opens a chip of its own for a mark nobody wore, at the end`, () => {
        expect(withPress([{ emoji: `👍`, by: [bob] }], { emoji: `🚀`, on: true }, me)).toEqual([
            { emoji: `👍`, by: [bob] },
            { emoji: `🚀`, by: [me] },
        ]);
        expect(withPress(undefined, { emoji: `🚀`, on: true }, me)).toEqual([{ emoji: `🚀`, by: [me] }]);
    });

    it(`takes the reader off a mark and leaves the others wearing it`, () => {
        expect(withPress([{ emoji: `👍`, by: [bob, { ...me, at: 2_000 }] }], { emoji: `👍`, on: false }, me)).toEqual([{ emoji: `👍`, by: [bob] }]);
    });

    it(`takes the chip away with its last wearer`, () => {
        expect(
            withPress(
                [
                    { emoji: `👍`, by: [{ ...me, at: 2_000 }] },
                    { emoji: `🚀`, by: [bob] },
                ],
                { emoji: `👍`, on: false },
                me,
            ),
        ).toEqual([{ emoji: `🚀`, by: [bob] }]);
    });

    // Pressing a mark the reader already wears (a second window caught up first) must not wear it twice.
    it(`leaves a mark the reader already wears as it is, whatever case their address arrived in`, () => {
        const worn = [{ emoji: `👍`, by: [{ email: `Ada@Example.com`, at: 2_000 }] }];
        expect(withPress(worn, { emoji: `👍`, on: true }, me)).toEqual(worn);
    });
});
