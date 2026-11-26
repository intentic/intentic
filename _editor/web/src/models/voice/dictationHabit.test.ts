import { DICTATED_KEY, dictationHabit, notingDictation, RECENT_DICTATION_MS } from "./dictationHabit";

// Who a hover over the mic loads the speech model for: a person whose dictated words were written in the last week.

const DAY = 24 * 60 * 60_000;

// A storage of its own and a clock the test moves.
const kept = () => {
    const values = new Map<string, string>();
    let now = 1_800_000_000_000;
    const habit = dictationHabit({ now: () => now, read: (key) => values.get(key), write: (key, value) => values.set(key, value) });
    return { habit, values, later: (ms: number) => (now += ms) };
};

describe(`whether a person dictates`, () => {
    it(`is no for someone who never has`, () => {
        expect(kept().habit.recent()).toBe(false);
    });

    it(`is yes for a week after their words were last written by dictation, and no from then on`, () => {
        const { habit, values, later } = kept();
        habit.dictated();
        expect(values.get(DICTATED_KEY)).toBe(`1800000000000`);
        expect(habit.recent()).toBe(true);
        later(RECENT_DICTATION_MS - 1);
        expect(habit.recent()).toBe(true);
        later(1);
        expect(habit.recent()).toBe(false);
        // Dictating again starts the week over.
        habit.dictated();
        later(6 * DAY);
        expect(habit.recent()).toBe(true);
    });

    it(`reads a value it cannot make out as never`, () => {
        const { habit, values } = kept();
        values.set(DICTATED_KEY, `yesterday`);
        expect(habit.recent()).toBe(false);
    });

    it(`is kept with the signed-in account, under its own name`, () => {
        expect(DICTATED_KEY).toBe(`intentic.voice.dictatedAt`);
    });
});

describe(`noting dictation as words are written`, () => {
    it(`notes words, never a phrase heard as silence, and hands each on as it came`, () => {
        const { habit } = kept();
        const noted: string[] = [];
        const written: [string, number][] = [];
        const write = notingDictation({ recent: habit.recent, dictated: () => noted.push(`dictated`) }, (text: string, at: number) =>
            written.push([text, at]),
        );
        write(``, 1);
        expect(noted).toEqual([]);
        write(`dzień dobry`, 2);
        expect(noted).toEqual([`dictated`]);
        expect(written).toEqual([
            [``, 1],
            [`dzień dobry`, 2],
        ]);
    });
});
