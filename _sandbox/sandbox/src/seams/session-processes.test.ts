import { describe, expect, test } from "bun:test";
import { sessionOf } from "./session-processes.js";

describe("the session a /proc stat line names", () => {
    test("is the fourth field after the comm, whatever the comm holds", () => {
        expect(sessionOf("4242 (bun) S 4200 4242 4100 0 -1 4194560")).toBe(4100);
        expect(sessionOf("4242 (a (weird) name) S 4200 4242 4100 0 -1 4194560")).toBe(4100);
    });

    test("is nothing for a process that is gone or a line that is not one", () => {
        expect(sessionOf("")).toBeUndefined();
        expect(sessionOf("4242 (bun) S")).toBeUndefined();
    });
});
