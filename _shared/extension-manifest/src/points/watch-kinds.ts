import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// (2026-11-26) A WATCH KIND: a ready-made check an automation can name instead of a guard command, which this extension's
// backend answers (`api.checks.serve(kind, handler)`) and the daemon calls through the backend host's door, under the
// scheduler, with no shell and no model. The daemon keeps one kind of its own, `url` (a page's text); every other kind is
// declared here, so the composer, the `automations` command and an automation's approval card draw it from this
// declaration rather than from a list in the core. An automation stores its source as `{ kind: <id>, ...parameters }`,
// each parameter one of `fields`, and saving checks it against them. Before this the daemon held the npm and GitHub
// release clients itself and the five places that named a kind each listed them.

// A kind's id, as an automation names it: a lowercase word. `url` is the daemon's own.
export const WATCH_KIND_ID = /^(?!url$)[a-z][a-z0-9-]{0,63}$/u;
// A parameter's name, as an automation stores it beside `kind`.
export const WATCH_PARAM_KEY = /^(?!kind$)[a-z][a-zA-Z0-9]{0,39}$/u;
// What a parameter holds: a line of text, or a switch that is on.
export type WatchParamValue = string | boolean;
export type WatchParams = Readonly<Record<string, WatchParamValue | undefined>>;

// The longest a text parameter may be when its field names no bound of its own.
const TEXT_MAX = 2000;

const compiles = (pattern: string): boolean => {
    try {
        void new RegExp(pattern, "u");
        return true;
    } catch {
        // allow(silent-catch): not compiling is the answer this asks for
        return false;
    }
};

export const WatchKindFieldSchema = z.object({
    key: z
        .string()
        .regex(WATCH_PARAM_KEY, "a parameter's key is a camelCase word, and not `kind`")
        .describe("The parameter's name as the automation stores it, beside `kind`: what `--with <key>=<value>` sets on the command line."),
    label: z.string().min(1).max(80).describe("The box's label in the composer."),
    type: z
        .enum(["text", "switch"])
        .optional()
        .describe("`text` (the default): a line of text, stored as typed. `switch`: on or off, stored as `true` only when on."),
    required: z.boolean().optional().describe("Whether a source of this kind must carry it. A switch is never required."),
    placeholder: z.string().min(1).max(200).optional().describe("An example value, shown in the empty box."),
    hint: z.string().min(1).max(300).optional().describe("One sentence on what it changes, behind the field's (i)."),
    pattern: z
        .string()
        .min(1)
        .max(300)
        .refine(compiles, "the pattern does not compile as a regular expression")
        .optional()
        .describe("A regular expression a text value must match, checked when the automation is saved, in the composer and by the command."),
    patternHint: z.string().min(1).max(120).optional().describe("What a value that matches looks like, said when one does not: `owner/name`."),
    maxLength: z.number().int().positive().max(TEXT_MAX).optional().describe(`The longest a text value may be. Absent means ${TEXT_MAX} characters.`),
});
export type WatchKindField = z.infer<typeof WatchKindFieldSchema>;

// `{key}` names a parameter; a `[…]` segment is left out when a parameter it names is absent or off.
const PLACEHOLDER = /\{([a-zA-Z0-9]+)\}/gu;
const SEGMENT = /\[([^[\]]*)\]/gu;

/** The parameters a sentence names, outside and inside its optional segments. */
export const sentenceKeys = (sentence: string): string[] => [...sentence.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");

// The declaration's fields, before the rules across them: what the catalogue's shape (the contract's WatchKindSchema)
// is made from, since a refined schema cannot be narrowed.
export const WatchKindDeclarationSchema = z.object({
        id: z
            .string()
            .regex(WATCH_KIND_ID, "a watch kind's id is a lowercase word: letters, digits and dashes, and not `url`, the sandbox's own")
            .describe("The kind's id, which an automation's source names as `kind`. Keep it once shipped: a stored automation names it."),
        label: z.string().min(1).max(40).describe("What the composer's chip says: a few words, like `npm package`."),
        icon: z.string().min(1).optional().describe("A name from the host's icon set for the chip."),
        logo: z.string().min(1).optional().describe("A simple-icons slug, drawn where a logo fits better than an icon."),
        description: z.string().min(1).max(300).describe("One sentence under the chips on what the check looks at and when it passes."),
        sentence: z
            .string()
            .min(1)
            .max(200)
            .describe(
                "What one source of this kind watches, in a few words, for the automation's row, its approval card and the wake: `{key}` puts a parameter in, and a `[…]` segment is left out when a parameter it names is absent or off, like `GitHub releases of {repo}[ (prereleases too){prereleases}]`. A switch puts nothing in: it only keeps its segment.",
            ),
        fields: z.array(WatchKindFieldSchema).max(12).describe("Its parameters, in the order the composer draws them."),
        capabilities: z
            .array(z.string().min(1))
            .optional()
            .describe(
                "Ids of this extension's own capability cards whose credential-gateway addresses each check is handed, as the automation's role reaches them: a GitHub card for a private repository's releases. Never a credential itself.",
            ),
});

export const WatchKindContributionSchema = WatchKindDeclarationSchema
    .superRefine((kind, ctx) => {
        const keys = kind.fields.map((field) => field.key);
        const doubled = keys.find((key, index) => keys.indexOf(key) !== index);
        if (doubled !== undefined) {
            ctx.addIssue({ code: "custom", path: ["fields"], message: `the field "${doubled}" is declared twice` });
        }
        const unknown = sentenceKeys(kind.sentence).find((key) => !keys.includes(key));
        if (unknown !== undefined) {
            ctx.addIssue({ code: "custom", path: ["sentence"], message: `the sentence names "{${unknown}}", which is none of the kind's fields` });
        }
        for (const [index, field] of kind.fields.entries()) {
            if (field.type === "switch" && (field.required === true || field.pattern !== undefined || field.maxLength !== undefined)) {
                ctx.addIssue({ code: "custom", path: ["fields", index], message: `a switch is never required and has no pattern or length` });
            }
        }
    })
    .meta({ power: { key: "watch-kind:${id}", sentence: 'its backend checks "${label}" watches for the sandbox\'s automations' } });
export type WatchKindContribution = z.infer<typeof WatchKindContributionSchema>;

// What renders a sentence or checks parameters: the declaration, with or without the parts only its manifest carries.
export type DeclaredWatchKind = Pick<WatchKindContribution, "id" | "sentence" | "fields">;

const present = (value: WatchParamValue | undefined): boolean => value !== undefined && value !== false && value !== "";
// A text parameter's words; a switch, on or off, puts none in.
const wordsOf = (value: WatchParamValue | undefined): string => (value === undefined || value === true || value === false ? "" : value);

/**
 * One source's sentence, as its kind declares it: `npm bun@>=1.4.3`, `GitHub releases of oven-sh/bun`. A kind nobody
 * declares here reads as its id and its parameters, so a source whose extension is off still says what it was.
 */
export const watchSentence = (kind: DeclaredWatchKind | undefined, params: WatchParams & { readonly kind: string }): string => {
    if (kind === undefined) {
        const named = Object.entries(params).filter(([key, value]) => key !== "kind" && present(value));
        return named.length === 0 ? params.kind : `${params.kind} ${named.map(([key, value]) => (value === true ? key : `${key}=${wordsOf(value)}`)).join(" ")}`;
    }
    const fill = (text: string): string => text.replace(PLACEHOLDER, (_whole, key: string) => wordsOf(params[key]));
    return fill(kind.sentence.replace(SEGMENT, (_whole, inner: string) => (sentenceKeys(inner).every((key) => present(params[key])) ? inner : ""))).trim();
};

// One field's value as saving accepts it, each refusal naming the field.
const fieldSchema = (field: WatchKindField): z.ZodType => {
    if (field.type === "switch") {
        return z.boolean({ error: `${field.label} is on or off` }).optional();
    }
    const max = field.maxLength ?? TEXT_MAX;
    let text = z
        .string({ error: `${field.label} ${field.required === true ? "is required" : "takes text"}` })
        .refine((value) => value.trim() !== "", `${field.label} is empty`)
        .refine((value) => value.length <= max, `${field.label} is longer than ${max} characters`);
    if (field.pattern !== undefined && compiles(field.pattern)) {
        const pattern = new RegExp(field.pattern, "u");
        text = text.refine((value) => pattern.test(value), field.patternHint === undefined ? `${field.label} does not look right` : `${field.label} must look like ${field.patternHint}`);
    }
    return field.required === true ? text : text.optional();
};

/** The parameters a kind takes, as one schema: its fields, and nothing it does not declare. */
export const watchParamsSchema = (kind: DeclaredWatchKind): z.ZodType<Readonly<Record<string, WatchParamValue | undefined>>> => {
    const takes = kind.fields.map((field) => field.key).join(", ");
    // SAFETY: every field's schema above answers a string, a boolean or nothing, so the object answers that record.
    return z.strictObject(Object.fromEntries(kind.fields.map((field) => [field.key, fieldSchema(field)])), {
        error: (issue) => (issue.code === "unrecognized_keys" ? `a ${kind.id} watch has no ${issue.keys.join(", ")}${takes === "" ? "" : `: it takes ${takes}`}` : undefined),
    }) as z.ZodType<Readonly<Record<string, WatchParamValue | undefined>>>;
};

/**
 * Why a source's parameters do not fit its kind's fields, in a sentence naming the field, or undefined when they do:
 * what saving refuses, the composer says at the box and the command says before it asks.
 */
export const watchParamsProblem = (kind: DeclaredWatchKind, params: WatchParams): string | undefined => {
    const { kind: _kind, ...rest } = params;
    return watchParamsSchema(kind).safeParse(rest).error?.issues[0]?.message;
};

export const watchKindsPoint = {
    name: "watchKinds",
    description:
        "Ready-made checks an automation can name instead of a guard command: a package's version, a service's newest release. Your backend answers each check (`api.checks.serve(id, handler)`), and the sandbox runs it on the automation's schedule with no shell and no model, firing only when it passes or when what it saw changed. The composer, the `automations` command and the approval card draw each kind from this declaration. Needs a `server` bundle.",
    schema: z.array(WatchKindContributionSchema),
} as const satisfies ContributionPoint;
