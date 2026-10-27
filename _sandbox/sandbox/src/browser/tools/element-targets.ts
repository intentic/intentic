import { z } from "zod";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { McpToolSchema } from "./browser-router.js";

// An element target as a weak model sends it, made into what @playwright/mcp 0.0.83 parses before a backend is paid
// for. Upstream reads a target as a ref only when it is exactly /^(f\d+)?e\d+$/ and hands anything else to the selector
// parser (tab.ts targetLocators), so the shape a snapshot prints a ref in failed there: `ref=e1780` as `Unknown engine
// "ref"` (26 calls) and an empty target as `Unexpected token "" while parsing css selector ""` (60), both in the four
// days to 2026-10-27, mostly gemini-3.1-flash-lite driving X through the signed-in `browser` (a-x-follow-mvn4jes88),
// also on `web`. A missing one failed as zod's `expected string, received undefined → at target`.
// A ref-shaped target goes on as the bare ref; an empty or missing required one is refused saying what `target` takes.
// Nothing is made from `element`, the human description: a selector guessed from it can act on the wrong element.

// Each property upstream reads a target from, beside the description that rides with it.
const DESCRIBED_BY = { target: "element", startTarget: "startElement", endTarget: "endElement" } as const;
type TargetKey = keyof typeof DESCRIBED_BY;
const isTargetKey = (key: string): key is TargetKey => Object.hasOwn(DESCRIBED_BY, key);

// A ref as a snapshot prints it (`[ref=e12]`), as a selector engine would name it (`ref=e12`, `aria-ref=e12`), quoted,
// or bare; `f1e3` is a ref inside a frame.
const REF = /^\[?\s*(?:(?:aria-)?ref\s*[=:]\s*)?["']?((?:f\d+)?e\d+)["']?\s*\]?$/u;

const TAKES = "pass the element's ref from the latest snapshot (e.g. e12) or a unique selector";

/** The bare ref a target names, or undefined for a target that is not a ref (a selector). */
const refOf = (target: string): string | undefined => REF.exec(target.trim())?.[1];

// A tool call's arguments, as the router hands them on.
type Args = NonNullable<RpcMessage["params"]>;
type ObjectSchema = NonNullable<McpToolSchema["inputSchema"]>;

// What a target property may hold for this to judge it; anything else (a number, an object) is left to upstream's own
// validation to name.
const TargetValue = z.string().nullish();
const Described = z.string().trim().min(1);
// A list of objects with targets of their own: browser_fill_form's `fields`.
const ItemsSchema = z.looseObject({
    type: z.literal("array"),
    items: z.looseObject({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).exactOptional() }),
});
const ObjectList = z.array(z.record(z.string(), z.unknown()));

// Older @playwright/mcp named the target `ref`; a model that learned that schema sends it there, and upstream's zod drops
// it as unknown before reporting `target` missing. Moved only when it holds a ref.
const movedRef = (args: Args, key: TargetKey): string | undefined => {
    const ref = z.string().safeParse(args["ref"]);
    if (key !== "target" || !ref.success || refOf(ref.data) === undefined) {
        return undefined;
    }
    delete args["ref"];
    return ref.data;
};

// Why a required target that holds nothing is refused, naming what it takes.
const missing = (args: Args, key: TargetKey, at: string, empty: boolean): string => {
    const named = `\`${at}${key}\``;
    if (empty) {
        return `${named} is empty: ${TAKES}`;
    }
    const described = Described.safeParse(args[DESCRIBED_BY[key]]);
    return described.success
        ? `${named} is required: ${TAKES}. \`${at}${DESCRIBED_BY[key]}\` ("${described.data}") only describes the element, it does not find it`
        : `${named} is required: ${TAKES}`;
};

// Sets one target property of `args` right where it can be, answering what is still wrong with it. An empty optional
// target is dropped, since upstream already reads one as absent (`if (params.target)`).
const settleTarget = (args: Args, key: TargetKey, required: boolean, at: string): string | undefined => {
    const value = TargetValue.safeParse(args[key] ?? movedRef(args, key));
    if (!value.success) {
        return undefined;
    }
    const given = value.data ?? undefined;
    if (given !== undefined && given.trim() !== "") {
        args[key] = refOf(given) ?? given;
        return undefined;
    }
    delete args[key];
    return required ? missing(args, key, at, given !== undefined) : undefined;
};

interface Settled {
    readonly args: Args;
    readonly problems: readonly string[];
}

const settleObject = (given: Args, schema: ObjectSchema, at: string): Settled => {
    const args = { ...given };
    const problems: string[] = [];
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (isTargetKey(key)) {
            const problem = settleTarget(args, key, schema.required?.includes(key) === true, at);
            problems.push(...(problem === undefined ? [] : [problem]));
            continue;
        }
        const items = ItemsSchema.safeParse(property);
        const list = ObjectList.safeParse(args[key]);
        if (items.success && list.success) {
            const settled = list.data.map((item, index) => settleObject(item, items.data.items, `${at}${key}[${index}].`));
            args[key] = settled.map((each) => each.args);
            problems.push(...settled.flatMap((each) => each.problems));
        }
    }
    return { args, problems };
};

/**
 * A call's arguments with every element target its tool's schema declares settled: ref-shaped ones as the bare ref,
 * empty optional ones dropped; or the refusal naming each required target that is empty or missing. A tool the schema
 * list does not hold goes on as asked.
 */
export const settleTargets = (tool: McpToolSchema | undefined, args: Args): { readonly args: Args } | { readonly refusal: string } => {
    if (tool?.inputSchema === undefined) {
        return { args };
    }
    const settled = settleObject(args, tool.inputSchema, "");
    return settled.problems.length === 0 ? { args: settled.args } : { refusal: settled.problems.join("; ") };
};
