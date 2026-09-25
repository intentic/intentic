import type { z } from "zod";

// What a manifest field MEANS to the host, declared on the field itself with `.meta()`, so the schema is the one place
// that says it: the powers an update re-asks for (powers-diff.ts), what adding a card does to the sandbox (the capability
// catalog's effects) and which capability kinds register an `mcp__<id>__` server (the contract's reserved names) are all
// read from here, never re-listed beside the schema.

// A template is plain text with `${path}` holes filled from the entry the field belongs to: `${id}`, `${catalog.name}`,
// and `${value}` for a scalar in a list. `${path|sep}` joins a list with `sep` (", " by default), `${path?yes:no}` picks
// by whether the value is set and not false.
export interface PowerMeaning {
    // The stable key an owner's approval is pinned to: an update re-asks when a key appears.
    readonly key: string;
    // The plain sentence shown for it.
    readonly sentence: string;
}

// The capability-catalog effect a field adds when it is present on a card (`@intentic/capability-catalog`, effects.ts).
export type EffectMeaning = "mcp" | "image" | "process";

export interface FieldMeaning {
    // Present (and not `false`) grants this power.
    readonly power?: PowerMeaning;
    readonly effect?: EffectMeaning;
    // A card of this kind, or with this field set, registers an `mcp__<card id>__` server for the turn.
    readonly mintsServer?: boolean;
}

// The meaning a schema carries, gathered through its wrappers (optional, default, pipe): `.meta()` may sit on any of
// them, and a `.describe()` clone inherits its parent's.
const readMeta = (schema: z.ZodType): FieldMeaning => {
    const { power, effect, mintsServer } = (schema.meta() ?? {}) as FieldMeaning;
    return { ...(power === undefined ? {} : { power }), ...(effect === undefined ? {} : { effect }), ...(mintsServer === undefined ? {} : { mintsServer }) };
};

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

interface Unwrapped {
    readonly schema: z.ZodType;
    readonly meaning: FieldMeaning;
}

// The schema under its wrappers, with every meaning met on the way down merged (the outermost wins a clash).
export const unwrapMeaning = (schema: z.ZodType): Unwrapped => {
    let current = schema;
    // Outermost first, so the merge below lets it win.
    const met: FieldMeaning[] = [];
    for (;;) {
        met.unshift(readMeta(current));
        const def = current._zod.def as unknown as { type: string; innerType?: z.ZodType; in?: z.ZodType };
        if (WRAPPERS.has(def.type) && def.innerType !== undefined) {
            current = def.innerType;
        } else if (def.type === "pipe" && def.in !== undefined) {
            current = def.in;
        } else {
            return { schema: current, meaning: Object.assign({}, ...met) as FieldMeaning };
        }
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const lookup = (context: Record<string, unknown>, path: string): unknown =>
    path.split(".").reduce<unknown>((at, part) => (isRecord(at) ? at[part] : undefined), context);

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== false && value !== "";

// The template's holes, outermost only, so a branch of `${path?yes:no}` may hold holes of its own.
const holesOf = (template: string): { readonly start: number; readonly end: number; readonly body: string }[] => {
    const holes: { start: number; end: number; body: string }[] = [];
    for (let at = template.indexOf("${"); at !== -1; at = template.indexOf("${", at)) {
        let depth = 0;
        let close = -1;
        for (let i = at + 1; i < template.length; i++) {
            if (template[i] === "{") {
                depth++;
            } else if (template[i] === "}" && --depth === 0) {
                close = i;
                break;
            }
        }
        if (close === -1) {
            break;
        }
        holes.push({ start: at, end: close + 1, body: template.slice(at + 2, close) });
        at = close + 1;
    }
    return holes;
};

// Fills a template's holes from `context`; see PowerMeaning for the three forms.
export const fillTemplate = (template: string, context: Record<string, unknown>): string => {
    let filled = "";
    let from = 0;
    for (const hole of holesOf(template)) {
        filled += template.slice(from, hole.start);
        from = hole.end;
        const choice = /^([\w.]+)\?([\s\S]*)$/u.exec(hole.body);
        if (choice !== null) {
            // The branch separator is the first `:` outside a nested hole.
            const branches = choice[2] ?? "";
            let depth = 0;
            let split = -1;
            for (let i = 0; i < branches.length; i++) {
                const char = branches[i];
                depth += char === "{" ? 1 : char === "}" ? -1 : 0;
                if (char === ":" && depth === 0) {
                    split = i;
                    break;
                }
            }
            const [yes, no] = split === -1 ? [branches, ""] : [branches.slice(0, split), branches.slice(split + 1)];
            filled += fillTemplate(present(lookup(context, choice[1] ?? "")) ? yes : no, context);
            continue;
        }
        const [path = "", separator = ", "] = hole.body.split("|");
        const value = lookup(context, path);
        filled += Array.isArray(value) ? value.map(String).join(separator) : value === undefined || value === null ? "" : String(value);
    }
    return filled + template.slice(from);
};

// Which member of a union a value is: the discriminated union's own key when it has one, else the first that parses.
const optionFor = (options: readonly z.ZodType[], value: unknown, discriminator: string | undefined): z.ZodType | undefined => {
    if (discriminator !== undefined && isRecord(value)) {
        for (const option of options) {
            const shape = (unwrapMeaning(option).schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
            const literal = shape?.[discriminator]?._zod.def as { values?: readonly unknown[] } | undefined;
            if (literal?.values?.includes(value[discriminator]) === true) {
                return option;
            }
        }
    }
    return options.find((option) => option.safeParse(value).success);
};

// Walks a value alongside its schema, calling `visit` for each node carrying a meaning, with the value there and the
// entry it belongs to (the object itself for an object, the enclosing one for a field, `{ value }` over it for a scalar
// in a list).
export const walkMeaning = (
    schema: z.ZodType,
    value: unknown,
    visit: (meaning: FieldMeaning, context: Record<string, unknown>) => void,
    parent: Record<string, unknown> = {},
): void => {
    if (!present(value)) {
        return;
    }
    const { schema: inner, meaning } = unwrapMeaning(schema);
    const context = isRecord(value) ? value : { ...parent, value };
    if (Object.keys(meaning).length > 0) {
        visit(meaning, context);
    }
    const def = inner._zod.def as unknown as {
        type: string;
        shape?: Record<string, z.ZodType>;
        element?: z.ZodType;
        options?: readonly z.ZodType[];
        discriminator?: string;
    };
    if (def.type === "object" && def.shape !== undefined && isRecord(value)) {
        for (const [key, field] of Object.entries(def.shape)) {
            walkMeaning(field, value[key], visit, value);
        }
    } else if (def.type === "array" && def.element !== undefined && Array.isArray(value)) {
        for (const element of value) {
            walkMeaning(def.element, element, visit, parent);
        }
    } else if (def.type === "union" && def.options !== undefined) {
        const option = optionFor(def.options, value, def.discriminator);
        if (option !== undefined) {
            walkMeaning(option, value, visit, parent);
        }
    }
};

// Every field of an object schema (or a union of them) that carries a meaning, by key, without a value: what a schema
// declares, as opposed to what one manifest uses.
export const fieldMeanings = (schema: z.ZodType): Map<string, FieldMeaning> => {
    const meanings = new Map<string, FieldMeaning>();
    const shape = (unwrapMeaning(schema).schema as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
    for (const [key, field] of Object.entries(shape)) {
        const { meaning } = unwrapMeaning(field);
        if (Object.keys(meaning).length > 0) {
            meanings.set(key, meaning);
        }
    }
    return meanings;
};
