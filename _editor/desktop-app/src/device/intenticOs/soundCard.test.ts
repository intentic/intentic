import { example, GOLDEN } from "./golden.testing";
import { currentOutputOf, mergeChange, outputOptionsOf, soundAfter, volumeChange, volumeIconOf, volumeOf } from "./soundCard";

// The sound as the card reads it: the glyph beside the slider, what a slider move changes, the status drawn before ic
// has answered, and the speakers to pick from. The answers are the contract's own examples of `ic os sound`.

const playing = example(GOLDEN.soundStatus, 0);
const muted = example(GOLDEN.soundStatus, 1);

describe(`the volume`, () => {
    it(`shows off while muted or at nothing, and on otherwise`, () => {
        expect(volumeIconOf(playing)).toBe(`volume-up`);
        expect(volumeIconOf(muted)).toBe(`volume-off`);
        expect(volumeIconOf(example(GOLDEN.soundStatus, 2))).toBe(`volume-off`);
    });

    it(`is a whole number from 0 to 100 wherever the slider left it`, () => {
        expect([-3, 0, 39.6, 100, 140, Number.NaN].map(volumeOf)).toEqual([0, 0, 40, 100, 100, 0]);
    });

    it(`turns the sound back on when the slider moves while it is off`, () => {
        expect(volumeChange(playing, 55)).toEqual({ volume: 55 });
        expect(volumeChange(muted, 55)).toEqual({ volume: 55, muted: false });
    });

    it(`is drawn as it will be, and two changes before the first was sent are one`, () => {
        expect(soundAfter(playing, { volume: 70.4 })).toEqual({ ...playing, volume: 70 });
        expect(soundAfter(playing, { muted: true })).toEqual({ ...playing, muted: true });
        expect(soundAfter(muted, {})).toEqual(muted);
        expect(mergeChange(undefined, { volume: 10 })).toEqual({ volume: 10 });
        expect(mergeChange({ volume: 10, muted: false }, { volume: 30 })).toEqual({ volume: 30, muted: false });
        expect(mergeChange({ volume: 10 }, { muted: true })).toEqual({ volume: 10, muted: true });
    });
});

describe(`where it plays`, () => {
    it(`is picked by the system's name, by ic's id, the one in use chosen`, () => {
        const outputs = example(GOLDEN.soundOutputs);
        expect(outputOptionsOf(outputs)).toEqual([
            { value: `49`, label: `Built-in Audio Analog Stereo` },
            { value: `58`, label: `HDMI / DisplayPort 1 Output` },
        ]);
        expect(currentOutputOf(outputs)).toBe(`49`);
        expect(currentOutputOf(example(GOLDEN.soundOutputs, 1))).toBeUndefined();
    });
});
