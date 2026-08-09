import { describe, expect, it } from "vitest";
import { flag, flagAll, has, number, parseArgs } from "./args.js";

describe(`parseArgs`, () => {
    it(`takes the verb, then everything else that is not a flag`, () => {
        const args = parseArgs([`find`, `Ada`, `Lovelace`]);
        expect(args.verb).toBe(`find`);
        expect(args.positionals).toEqual([`Ada`, `Lovelace`]);
    });

    it(`reads both --flag value and --flag=value`, () => {
        expect(flag(parseArgs([`find`, `--type`, `person`]), `type`)).toBe(`person`);
        expect(flag(parseArgs([`find`, `--type=person`]), `type`)).toBe(`person`);
    });

    /* The agent will repeat a flag without being told it can, and dropping one of the two would silently
     * discard half of what it asked for. */
    it(`collects a repeated flag rather than keeping one`, () => {
        expect(flagAll(parseArgs([`new`, `Ada`, `--tag`, `colleague`, `--tag`, `math`]), `tag`)).toEqual([`colleague`, `math`]);
    });

    it(`does not swallow the next flag as a value`, () => {
        const args = parseArgs([`find`, `--type`, `--json`]);
        expect(flag(args, `type`)).toBeUndefined();
        expect(has(args, `json`)).toBe(true);
    });

    it(`treats a switch as a switch even with something after it`, () => {
        const args = parseArgs([`find`, `--json`, `Ada`]);
        expect(has(args, `json`)).toBe(true);
        expect(args.positionals).toEqual([`Ada`]);
    });

    it(`falls back on a limit that is not a positive number`, () => {
        expect(number(parseArgs([`find`, `--limit`, `zero`]), `limit`, 25)).toBe(25);
        expect(number(parseArgs([`find`, `--limit`, `-3`]), `limit`, 25)).toBe(25);
        expect(number(parseArgs([`find`, `--limit`, `5`]), `limit`, 25)).toBe(5);
    });

    it(`answers an empty command line without inventing a verb`, () => {
        expect(parseArgs([]).verb).toBe(``);
    });
});
