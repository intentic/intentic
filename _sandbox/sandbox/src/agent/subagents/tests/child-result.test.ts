import { checkResult, resultContract, resultInText, type ResultSchema, resultSchemaFault, turnResult } from "../child-result.js";

// A child's structured result: which schemas a parent may name, how a value is held to one, and where a child that never
// called its tool is read for one.

const FINDINGS: ResultSchema = {
    type: "object",
    properties: {
        verdict: { type: "string", enum: ["real", "false-positive"] },
        line: { type: "integer", minimum: 1 },
        notes: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: ["verdict", "line"],
    additionalProperties: false,
};

describe("which schemas a parent may name", () => {
    it("takes a record of typed fields", () => {
        expect(resultSchemaFault(FINDINGS)).toBeUndefined();
    });

    it("refuses a regular expression, naming where it is", () => {
        expect(resultSchemaFault({ type: "object", properties: { id: { type: "string", pattern: "^(a+)+$" } } })).toBe(
            "The result schema cannot be used: schema.properties.id.pattern: not a keyword a result schema may use (it may use type, properties, required, items, enum, const, description, title, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems, additionalProperties, default).",
        );
    });

    it("refuses a reference out of the document", () => {
        expect(resultSchemaFault({ $ref: "#/definitions/x" })).toMatch(/^The result schema cannot be used: schema\.\$ref: not a keyword/u);
    });

    it("refuses a schema for additional properties, which only true or false may stand for", () => {
        expect(resultSchemaFault({ type: "object", additionalProperties: { type: "string" } })).toBe(
            "The result schema cannot be used: schema.additionalProperties: true or false.",
        );
    });

    it("refuses one nested past ten levels", () => {
        let schema: ResultSchema = { type: "string" };
        for (let level = 0; level < 11; level += 1) {
            schema = { type: "array", items: schema };
        }
        expect(resultSchemaFault(schema)).toBe("The result schema cannot be used: schema.items.items.items.items.items.items.items.items.items.items.items: nested deeper than 10 levels.");
    });

    it("refuses one larger than a record", () => {
        const properties = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`field_${index}`, { type: "string", description: "x" }]));
        expect(resultSchemaFault({ type: "object", properties })).toMatch(/^The result schema is \d+ characters written out; keep it under 16000\.$/u);
    });
});

describe("a value held to the schema", () => {
    it("takes a value that matches", () => {
        expect(checkResult(FINDINGS, { verdict: "real", line: 12 })).toEqual({ value: { verdict: "real", line: 12 } });
    });

    it("says every field that does not, by its path", () => {
        expect(checkResult(FINDINGS, { verdict: "maybe", line: 0 })).toEqual({
            error: 'verdict: Invalid option: expected one of "real"|"false-positive"; line: Too small: expected number to be >=1',
        });
    });

    it("refuses a field the schema closed off", () => {
        expect(checkResult(FINDINGS, { verdict: "real", line: 3, extra: true })).toEqual({ error: 'value: Unrecognized key: "extra"' });
    });
});

describe("a value read off a closing message", () => {
    it("is the last fenced JSON block", () => {
        expect(resultInText('First try:\n```json\n{"line": 1}\n```\nFinal:\n```json\n{"verdict": "real", "line": 4}\n```\n')).toEqual({
            verdict: "real",
            line: 4,
        });
    });

    it("is the whole message where it is JSON alone", () => {
        expect(resultInText(' {"verdict": "false-positive", "line": 9} ')).toEqual({ verdict: "false-positive", line: 9 });
    });

    it("is nothing in prose", () => {
        expect(resultInText("I fixed it and the tests pass.")).toBeUndefined();
    });
});

describe("a turn's result", () => {
    it("is nothing for a child spawned without a schema", () => {
        expect(turnResult(undefined, undefined, '{"line": 1}')).toBeUndefined();
    });

    it("is what its tool took, whatever its message says", () => {
        expect(turnResult(FINDINGS, { value: { verdict: "real", line: 2 } }, '```json\n{"verdict": "false-positive", "line": 7}\n```')).toEqual({
            value: { verdict: "real", line: 2 },
        });
    });

    it("is read off its message when it never called the tool", () => {
        expect(turnResult(FINDINGS, undefined, 'Done.\n```json\n{"verdict": "real", "line": 7}\n```')).toEqual({ value: { verdict: "real", line: 7 } });
    });

    it("says why there is none", () => {
        expect(turnResult(FINDINGS, undefined, "All done.")).toEqual({
            error: "It ended without calling its result tool, and its last message holds no JSON value.",
        });
        expect(turnResult(FINDINGS, undefined, '```json\n{"verdict": "real"}\n```')).toEqual({
            error: "It ended without calling its result tool, and the JSON at the end of its last message does not match the schema: line: Invalid input: expected number, received undefined",
        });
    });
});

describe("what the child is told", () => {
    it("names the tool, its server and the schema itself", () => {
        const told = resultContract({ type: "string" });
        expect(told).toContain("call the `result` tool (on the `subagents` server) exactly once");
        expect(told).toContain('```json\n{\n  "type": "string"\n}\n```');
    });
});
