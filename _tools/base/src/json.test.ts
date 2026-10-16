import { type JsonValue, parseJsonOr, parseJsonWith, type SafeParser } from "./json.js";

// zod's result shape, success and failure both, without the dependency: whole numbers only.
const portSchema: SafeParser<number> = {
    safeParse: (value: JsonValue) => (Number.isInteger(value) ? { success: true, data: Number(value) } : { success: false, error: new Error("not a port") }),
};

// A String object whose coercion throws, so what JSON.parse throws for it is a TypeError and not a SyntaxError.
class ThrowingText extends String {
    override toString(): string {
        throw new TypeError("no text here");
    }
}
// SAFETY: JSON.parse coerces its argument with ToString, which is the path this object exists to make throw.
const throwingText = new ThrowingText() as string;

describe("parseJsonOr", () => {
    it("parses JSON, falsy values included, and never hands back the fallback for them", () => {
        expect(parseJsonOr(`{"a":[1,"b",null]}`, "fallback")).toEqual({ a: [1, "b", null] });
        expect(parseJsonOr("0", "fallback")).toBe(0);
        expect(parseJsonOr("null", "fallback")).toBeNull();
        expect(parseJsonOr(`""`, "fallback")).toBe("");
        expect(parseJsonOr("false", "fallback")).toBe(false);
    });

    it("answers the fallback for every text that is not JSON", () => {
        const fallback = Symbol("fallback");
        expect(parseJsonOr("", fallback)).toBe(fallback);
        expect(parseJsonOr("{", fallback)).toBe(fallback);
        expect(parseJsonOr("undefined", fallback)).toBe(fallback);
        expect(parseJsonOr(`{"a":1}x`, fallback)).toBe(fallback);
    });

    it("rethrows what is not a SyntaxError", () => {
        expect(() => parseJsonOr(throwingText, "fallback")).toThrow(new TypeError("no text here"));
    });
});

describe("parseJsonWith", () => {
    it("answers what the schema reads when the text is JSON it accepts", () => {
        expect(parseJsonWith("8080", portSchema)).toBe(8080);
        expect(parseJsonWith("0", portSchema)).toBe(0);
    });

    it("answers undefined for JSON the schema refuses and for text that is not JSON", () => {
        expect(parseJsonWith(`"8080"`, portSchema)).toBeUndefined();
        expect(parseJsonWith("80.5", portSchema)).toBeUndefined();
        expect(parseJsonWith("null", portSchema)).toBeUndefined();
        expect(parseJsonWith("80 80", portSchema)).toBeUndefined();
    });

    it("never asks the schema about text that is not JSON", () => {
        const asked: JsonValue[] = [];
        const recording: SafeParser<JsonValue> = {
            safeParse: (value) => {
                asked.push(value);
                return { success: true, data: value };
            },
        };
        expect(parseJsonWith("nope", recording)).toBeUndefined();
        expect(parseJsonWith("[1]", recording)).toEqual([1]);
        expect(asked).toEqual([[1]]);
    });

    it("rethrows what is not a SyntaxError", () => {
        expect(() => parseJsonWith(throwingText, portSchema)).toThrow(new TypeError("no text here"));
    });
});
