import { newRowId, positionRowId } from "./row-ids.js";

describe("row ids", () => {
    it("mints twelve base-36 characters, a fresh one each time", () => {
        const ids = Array.from({ length: 200 }, () => newRowId());
        for (const id of ids) {
            expect(id).toMatch(/^[0-9a-z]{12}$/);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("draws a byte past the alphabet's last whole multiple again rather than folding it back", () => {
        const draws = [new Uint8Array([255, 252, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), new Uint8Array([35, 251])];
        const spy = jest.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
            const next = draws.shift();
            if (array instanceof Uint8Array && next !== undefined) {
                array.set(next.subarray(0, array.length));
            }
            return array;
        });
        try {
            expect(newRowId()).toBe("0123456789zz");
        } finally {
            spy.mockRestore();
        }
    });

    it("names a row recorded before ids by its position", () => {
        expect(positionRowId(7)).toBe("@7");
    });
});
