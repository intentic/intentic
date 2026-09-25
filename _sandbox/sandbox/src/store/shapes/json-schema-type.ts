// Spells a JSON Schema (as `z.toJSONSchema` emits it, the form the contract lock keeps) as a TypeScript type, for the
// shape generator to freeze. A schema that says nothing (JSON Schema's "anything", which is also what an unrepresentable
// zod type becomes) spells as `any`: a frozen shape with no information about a field must not fail every later one. Only what decides assignability is kept: object keys and which are required, element and
// value types, literal sets, unions. Descriptions, defaults and refinements (`minLength`, patterns) are dropped: the
// type system cannot see them, and a frozen shape that differs from the last only in them is the same shape.

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const key = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

const union = (members: readonly string[]): string => {
    const distinct = [...new Set(members)];
    if (distinct.includes("any")) {
        return "any";
    }
    return distinct.length === 0 ? "never" : distinct.length === 1 ? (distinct[0] ?? "never") : distinct.map((member) => (member.includes("&") ? `(${member})` : member)).join(" | ");
};

interface Context {
    readonly root: Schema;
    // References being spelled right now: a recursive shape stops at `any` instead of never ending.
    readonly visiting: ReadonlySet<string>;
}

const resolveRef = (ref: string, context: Context): Schema | undefined => {
    if (ref === "#") {
        return context.root;
    }
    const segments = ref.replace(/^#\//, "").split("/");
    let node: unknown = context.root;
    for (const segment of segments) {
        node = isSchema(node) ? node[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    }
    return isSchema(node) ? node : undefined;
};

const objectType = (schema: Schema, context: Context): string => {
    const properties = isSchema(schema["properties"]) ? schema["properties"] : {};
    const required = new Set(Array.isArray(schema["required"]) ? schema["required"].filter((name): name is string => typeof name === "string") : []);
    const names = Object.keys(properties).toSorted();
    const additional = schema["additionalProperties"];
    // A record: no declared keys, every value one shape.
    if (names.length === 0 && (isSchema(additional) || additional === true)) {
        return `Record<string, ${additional === true ? "any" : typeFromSchema(additional, context)}>`;
    }
    if (names.length === 0) {
        return "{}";
    }
    const members = names.map((name) => `${key(name)}${required.has(name) ? "" : "?"}: ${typeFromSchema(properties[name], context)}`);
    return `{ ${members.join("; ")} }`;
};

const arrayType = (schema: Schema, context: Context): string => {
    if (Array.isArray(schema["prefixItems"])) {
        const items = schema["prefixItems"].map((item) => typeFromSchema(item, context));
        return `[${items.join(", ")}]`;
    }
    const element = typeFromSchema(schema["items"], context);
    return element.includes("|") || element.includes("&") ? `(${element})[]` : `${element}[]`;
};

const PRIMITIVES: Readonly<Record<string, string>> = { string: "string", number: "number", integer: "number", boolean: "boolean", null: "null" };

const typedType = (type: string, schema: Schema, context: Context): string => {
    if (type === "object") {
        return objectType(schema, context);
    }
    if (type === "array") {
        return arrayType(schema, context);
    }
    return PRIMITIVES[type] ?? "any";
};

const combinator = (schema: Schema, context: Context): string | undefined => {
    for (const name of ["anyOf", "oneOf"] as const) {
        const members = schema[name];
        if (Array.isArray(members)) {
            return union(members.map((member) => typeFromSchema(member, context)));
        }
    }
    const all = schema["allOf"];
    if (Array.isArray(all)) {
        const parts = all.map((member) => typeFromSchema(member, context)).filter((part) => part !== "any");
        return parts.length === 0 ? "any" : parts.map((part) => (part.includes("|") ? `(${part})` : part)).join(" & ");
    }
    return undefined;
};

export const typeFromSchema = (schema: unknown, context?: Context): string => {
    if (schema === true || !isSchema(schema)) {
        return schema === false ? "never" : "any";
    }
    const within: Context = context ?? { root: schema, visiting: new Set() };
    const ref = schema["$ref"];
    if (typeof ref === "string") {
        const target = resolveRef(ref, within);
        return target === undefined || within.visiting.has(ref) ? "any" : typeFromSchema(target, { ...within, visiting: new Set([...within.visiting, ref]) });
    }
    if (Object.hasOwn(schema, "const")) {
        return JSON.stringify(schema["const"]);
    }
    if (Array.isArray(schema["enum"])) {
        return union(schema["enum"].map((value) => JSON.stringify(value)));
    }
    const combined = combinator(schema, within);
    if (combined !== undefined) {
        return combined;
    }
    const type = schema["type"];
    if (Array.isArray(type)) {
        return union(type.filter((member): member is string => typeof member === "string").map((member) => typedType(member, schema, within)));
    }
    if (typeof type === "string") {
        return typedType(type, schema, within);
    }
    // No type named: an object by its keywords, else anything at all.
    return isSchema(schema["properties"]) || schema["additionalProperties"] !== undefined ? objectType(schema, within) : "any";
};
