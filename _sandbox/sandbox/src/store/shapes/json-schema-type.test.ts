import { z } from "zod";
import { typeFromSchema } from "./json-schema-type.js";

const spell = (schema: z.ZodType, io: "input" | "output" = "input"): string => typeFromSchema(z.toJSONSchema(schema, { io, unrepresentable: "any" }));

test("object keys sort, and only what the input may omit is optional", () => {
    const schema = z.object({ zeta: z.string(), alpha: z.number().default(1), mid: z.boolean().optional() });
    expect(spell(schema)).toBe("{ alpha?: number; mid?: boolean; zeta: string }");
    // A build writes its defaults, so the output shape it leaves on disk requires them.
    expect(spell(schema, "output")).toBe("{ alpha: number; mid?: boolean; zeta: string }");
});

test("literal sets, records, arrays and nullables spell as their TypeScript forms", () => {
    expect(spell(z.enum(["off", "suggest", "auto"]))).toBe('"off" | "suggest" | "auto"');
    expect(spell(z.record(z.string(), z.array(z.number())))).toBe("Record<string, number[]>");
    expect(spell(z.array(z.union([z.string(), z.number()])))).toBe("(string | number)[]");
    expect(spell(z.string().nullable())).toBe("string | null");
    expect(spell(z.literal("fixed"))).toBe('"fixed"');
    expect(spell(z.tuple([z.string(), z.number()]))).toBe("[string, number]");
});

test("refinements and descriptions leave no trace, so two schemas differing only in them freeze as one shape", () => {
    expect(spell(z.object({ name: z.string().min(1).max(60).describe("What to call it.") }))).toBe(spell(z.object({ name: z.string() })));
});

test("a discriminated union keeps each arm's keys", () => {
    const schema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("cron"), at: z.string() }), z.object({ kind: z.literal("webhook") })]);
    expect(spell(schema)).toBe('{ at: string; kind: "cron" } | { kind: "webhook" }');
});

test("a key that is not an identifier is quoted, and a recursive shape stops at any", () => {
    expect(spell(z.object({ "has-dash": z.string() }))).toBe('{ "has-dash": string }');
    type Tree = { children: Tree[] };
    const TreeSchema: z.ZodType<Tree> = z.lazy(() => z.object({ children: z.array(TreeSchema) }));
    expect(spell(TreeSchema)).toBe("{ children: { children: any[] }[] }");
});

test("a schema that says nothing freezes as any, so it can never fail a later shape", () => {
    expect(spell(z.custom<Date>(() => true))).toBe("any");
    expect(typeFromSchema(true)).toBe("any");
    expect(typeFromSchema(false)).toBe("never");
});
