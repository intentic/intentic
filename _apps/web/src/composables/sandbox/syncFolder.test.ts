import { describe, expect, it } from "vitest";
import { syncFolder } from "./syncFolder";

describe(`syncFolder`, () => {
    it(`gives same-name sandboxes distinct folders by id`, () => {
        expect(syncFolder(`my`, `clh3k2j9x0000aaa`)).not.toBe(syncFolder(`my`, `clh3k2j9x0000bbb`));
    });

    it(`is stable for the same sandbox`, () => {
        expect(syncFolder(`my`, `clh3k2j9x0000aaa`)).toBe(syncFolder(`my`, `clh3k2j9x0000aaa`));
    });

    it(`falls back when the id is missing`, () => {
        expect(syncFolder(`my`, ``)).toBe(`~/intentic/my-new`);
    });
});
