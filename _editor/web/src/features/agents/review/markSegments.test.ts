import { describe, expect, it } from "vitest";
import { markSegments } from "./markSegments";

// The term is marked without v-html: this text is a chat's own words, which are not trusted markup.
describe(`markSegments`, () => {
    it(`marks every occurrence, not just the first`, () => {
        expect(markSegments(`land and land again`, `land`)).toEqual([
            { text: `land`, hit: true },
            { text: ` and `, hit: false },
            { text: `land`, hit: true },
            { text: ` again`, hit: false },
        ]);
    });

    it(`matches case-insensitively while keeping the original casing`, () => {
        expect(markSegments(`the LandAgent bug`, `landagent`)).toEqual([
            { text: `the `, hit: false },
            { text: `LandAgent`, hit: true },
            { text: ` bug`, hit: false },
        ]);
    });

    // Under the field's Aa switch the marks have to be as strict as the filter was: a lowercase twin lit up
    // here would claim a match the search never made.
    it(`marks only the exact casing when match case is on`, () => {
        expect(markSegments(`FROM and from`, `FROM`, true)).toEqual([
            { text: `FROM`, hit: true },
            { text: ` and from`, hit: false },
        ]);
        expect(markSegments(`only from here`, `FROM`, true)).toEqual([{ text: `only from here`, hit: false }]);
    });

    it(`returns one plain run when there is nothing to mark`, () => {
        expect(markSegments(`nothing here`, `zzz`)).toEqual([{ text: `nothing here`, hit: false }]);
        expect(markSegments(`nothing here`, ``)).toEqual([{ text: `nothing here`, hit: false }]);
    });
});
