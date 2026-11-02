import { answeredAt } from "./answeredAt";

describe("answeredAt", () => {
    test("reads the provider's last answer, however much later a land moved updatedAt", () => {
        expect(answeredAt({ answeredAt: 1_000, unfinished: { at: 900 }, updatedAt: 9_000 })).toBe(1_000);
    });

    test("a row from before the field falls back to its last turn's end, then to updatedAt", () => {
        expect(answeredAt({ unfinished: { at: 900 }, updatedAt: 9_000 })).toBe(900);
        expect(answeredAt({ updatedAt: 9_000 })).toBe(9_000);
    });
});
