import { evaluateWhen, isWhenExpression, parseWhen } from "@intentic/base/when";
import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";
import { MARK_FIELDS } from "../mark.js";

// A field the install dialog's config form renders (key, label, secret/optional flags, a select, a `when` gate);
// mirrors the platform catalog's own field shape.
export const CapabilityFieldSchema = z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    secret: z.boolean().optional().describe("Mask it, and never echo it back."),
    optional: z.boolean().optional(),
    multiline: z.boolean().optional(),
    // Folds this field behind the form's Advanced disclosure; it opens by itself while any advanced field holds a
    // non-default value.
    advanced: z
        .boolean()
        .optional()
        .describe(
            "Fold this field behind the form's Advanced disclosure: for answers whose default is right for nearly everyone. The disclosure opens by itself while any advanced field holds a non-default value, so an edit never hides live settings.",
        ),
    // Renders as a switch carrying "on"/"off", for an opt-in extra rather than a required decision; always holds a
    // value, so it never blocks a submit.
    boolean: z
        .boolean()
        .optional()
        .describe(
            'Render it as a switch, carrying "on"/"off". For an opt-in EXTRA rather than a decision: a two-option picker says the same thing but presents a choice the user must make to proceed, sized like the required fields around it. A switch always holds a value, so a field like this never blocks a submit.',
        ),
    // A line under the control for what the label alone can't say (a host requirement, when a value takes effect).
    hint: z
        .string()
        .optional()
        .describe(
            "A line under this control, for what the label alone cannot say: a host requirement, when a value takes effect. The card's own `hint` speaks for the whole card; this one is bound to the field it qualifies.",
        ),
    // Value only takes effect after a sandbox rebuild (rides the image overlay); shown as a chip since two
    // otherwise-identical switches can cost very differently.
    rebuild: z
        .boolean()
        .optional()
        .describe(
            "This value only takes effect after the sandbox is rebuilt, because it rides the image overlay. Shown as a chip beside the label: two switches side by side, identical in every visible way, can otherwise cost five seconds or five minutes with no way to tell which.",
        ),
    default: z.string().optional(),
    options: z
        .array(z.object({ value: z.string(), label: z.string() }))
        .optional()
        .describe("Turns the field into a select."),
    // Gates the field on answers already given; refused at parse when the `when` expression doesn't parse.
    when: z
        .string()
        .refine(isWhenExpression, { message: "not a valid `when` condition" })
        .optional()
        .describe(
            "Only show this field while a condition over the answers already given holds: `auth == 'key'`, `provider in ['ipsec', 'fortinet']`, `!advanced`. Supports `&&`, `||`, `!`, comparisons and `in`.",
        ),
    // A fixed value baked into the config rather than asked for, e.g. pinning a discriminator; renders as nothing.
    value: z
        .string()
        .optional()
        .describe(
            'A fixed value baked into the config rather than asked for: how a card pins its discriminator (platform="reddit", provider="stripe"). Renders as nothing.',
        ),
    // Marks this field as a TOTP seed; declare with `secret: true`. Unlike an ordinary secret it never reaches the
    // agent's environment, the daemon mints codes on demand.
    totp: z
        .boolean()
        .optional()
        .describe(
            "This field holds a TOTP seed, the base32 key or otpauth:// URI a service shows when enrolling an authenticator app. Declare it with `secret: true`. Unlike an ordinary secret it never enters the agent's environment: the daemon mints the six-digit codes on demand and only those cross.",
        ),
});
export type CapabilityField = z.infer<typeof CapabilityFieldSchema>;

// Whether a field is in play given the answers so far. The web form and the daemon's install-time check both need this
// same answer.
export const fieldApplies = (field: CapabilityField, values: Readonly<Record<string, unknown>>): boolean =>
    field.when === undefined || evaluateWhen(parseWhen(field.when), values);

// One authenticated request the daemon makes on the form's behalf, declared as data since the check is per-service.
// Worth declaring on any card whose failure is otherwise silent.
const ProbeSchema = z.object({
    url: z
        .string()
        .min(1)
        .describe("The URL to call, as a template over the fields: `${field}` substitutes, `${field:uri}` percent-encodes. Same spelling as `env`."),
    method: z.enum(["GET", "POST", "HEAD"]).optional().describe("Defaults to GET."),
    headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('The request headers, templated the same way: `{"Authorization": "Bearer ${token}"}`.'),
    // Dotted path into the JSON answer naming who the caller is, so success can say which account answered.
    identity: z
        .string()
        .optional()
        .describe('A dotted path into the JSON answer naming who the caller is ("login", "user.name"), so success can say which account answered.'),
    insecure: z
        .boolean()
        .optional()
        .describe("Accept a self-signed certificate, for a service whose local install ships one (Obsidian's Local REST API)."),
});

// The install-dialog card: how it looks in the grid and how the user gets its credential. Shared by every kind below.
const CatalogSchema = z.object({
    name: z.string().min(1),
    ...MARK_FIELDS,
    // One line, aim for 60 characters or fewer; the grid clamps this at two lines. Anything longer belongs in `hint`.
    description: z
        .string()
        .min(1)
        .describe(
            "ONE LINE: aim for 60 characters or fewer. The grid clamps it at two lines in a narrow pane, so a paragraph here is a paragraph the reader gets truncated. Everything longer belongs in `hint`.",
        ),
    category: z.string().min(1),
    // The paragraph shown under the add form and searched from the catalog; words someone would search for belong here
    // even if the tile can't show them.
    hint: z
        .string()
        .optional()
        .describe(
            'The paragraph, shown under the add form and searched from the catalog, so the words that identify this card to someone hunting for it ("webauthn", "socket mode") belong here even when the tile cannot show them.',
        ),
    // The credential-creation walkthrough the install dialog renders.
    guide: z
        .object({
            url: z.string().optional(),
            urlFromField: z.string().optional(),
            path: z.string().optional(),
            linkLabel: z.string().optional(),
            scopes: z.string().optional(),
            steps: z.array(z.string()).optional(),
        })
        .optional()
        .describe("The walkthrough the install dialog renders for getting the credential this card asks for."),
});

// Every arm carries these: the slug (the card's /capabilities/<id> route and the discriminator value the daemon
// resolves), the card, and its fields.
const contributionBase = {
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    catalog: CatalogSchema,
    fields: z.array(CapabilityFieldSchema),
};

// A capability card as data; kinds with genuine device privilege (docker, vpn, extension, devops) live in the platform
// catalog instead, since a manifest that could name them would grant itself that privilege.
export const CapabilityContributionSchema = z
    .discriminatedUnion("kind", [
        // A CLI tool the agent gets, authenticated: env vars templated over the fields, a SKILL.md cheatsheet, and an
        // optional image fragment for the client binary.
        z.object({
            ...contributionBase,
            kind: z.literal("cli"),
            fields: z.array(CapabilityFieldSchema).min(1),
            env: z
                .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string())
                .describe(
                    "The environment the agent's shell gets, as value templates over the fields: `${field}` substitutes, `${field:uri}` percent-encodes. Each name is suffixed per instance.",
                ),
            skill: z
                .string()
                .min(1)
                .describe("Checkout-relative SKILL.md teaching the agent this tool. `${id}` in it is replaced with the instance name at apply time."),
            fragment: z
                .string()
                .min(1)
                .optional()
                .describe("A Dockerfile fragment holding the client binary this tool needs (psql, mysql, whisper)."),
            // Prefer over `fragment` whenever the sandbox already ships a pack for the tool: an image that bakes the
            // pack needs no rebuild, and the overlay can't drift from it.
            pack: z
                .string()
                .min(1)
                .optional()
                .describe(
                    "A sandbox feature pack name (whisper, llamacpp, browser, …) supplying this tool. Preferred over `fragment`: an image that already bakes the pack needs no rebuild, and there is no copy to drift.",
                ),
            probe: ProbeSchema.optional().describe(
                "One authenticated request that tests this card's settings before they are saved, so a wrong token or an unreachable host is answered on the form rather than by a card that says 'not connected' afterwards.",
            ),
        }),
        // A site the agent acts on as the owner through the shared browser; `loginUrl`/`homeUrl` are both optional so a
        // card can be the generic one that asks for them on its form instead.
        z.object({
            ...contributionBase,
            kind: z.literal("browser"),
            loginUrl: z
                .url()
                .optional()
                .describe(
                    "What the sign-in window opens; the profile it persists IS the credential. Optional so one card can be the generic one that asks for the URL on its form instead, but a card must either pin this or declare a field that supplies it, or the window opens on nothing.",
                ),
            homeUrl: z
                .url()
                .optional()
                .describe(
                    "Where that same profile opens once it HAS a session: the owner's own hands on the connected browser. Separate from loginUrl because for some platforms the login lives on another site entirely (YouTube signs in at accounts.google.com).",
                ),
            skill: z
                .string()
                .min(1)
                .describe(
                    "Checkout-relative SKILL.md teaching the agent this site's actions: rendered once per site, all its connected accounts on one roster (`${accounts}`), the core tool note at `${tools}`.",
                ),
        }),
        // An operating system a connected computer can run; enrollment, socket and scope enforcement are core, only the
        // skill pack varies.
        z.object({
            ...contributionBase,
            kind: z.literal("host"),
            skill: z.string().min(1).describe("Checkout-relative SKILL.md teaching the agent that machine's shell."),
        }),
        // A browser family the user connects their own copy of; `install` is a URL since each family has its own store
        // or none at all.
        z.object({
            ...contributionBase,
            kind: z.literal("webext"),
            install: z.url().describe("Where this browser's extension is installed from: its store listing, or a page offering the build."),
            skill: z.string().min(1).describe("Checkout-relative SKILL.md teaching the agent to drive this browser."),
        }),
        // A preset over a core kind: no payload, just a name, a logo and a filled-in form.
        z.object({ ...contributionBase, kind: z.literal("agent") }),
    ])
    .superRefine((spec, ctx) => {
        // A totp field's env must never be referenced: that would hand the agent the seed itself instead of the
        // daemon's one-time codes.
        if (spec.kind !== "cli") {
            return;
        }
        for (const field of spec.fields.filter((candidate) => candidate.totp === true)) {
            if (Object.values(spec.env).some((template) => template.includes(`\${${field.key}}`) || template.includes(`\${${field.key}:uri}`))) {
                ctx.addIssue({
                    code: "custom",
                    message: `env must not reference the totp field "${field.key}", the daemon mints codes from it instead`,
                });
            }
        }
    });
export type CapabilityContribution = z.infer<typeof CapabilityContributionSchema>;
// Arms carrying a per-instance SKILL.md, templated and installed identically by the daemon.
export type SkillContribution = Extract<CapabilityContribution, { skill: string }>;

// The config key a kind's cards pin to their own id, so a stored capability traces back to its card. `agent` has none:
// its cards differ only in defaults.
const DISCRIMINATOR = { cli: "provider", browser: "platform", host: "platform", webext: "platform", agent: undefined } satisfies Record<
    CapabilityContribution["kind"],
    string | undefined
>;
export const contributionDiscriminator = (kind: string): string | undefined => DISCRIMINATOR[kind as keyof typeof DISCRIMINATOR];

export const capabilitiesPoint = {
    name: "capabilities",
    description:
        'Capability cards this pack adds to the "+" grid: a connected CLI tool, a site the agent acts on as the owner through the shared browser, an operating system pack, a browser family the owner connects their own copy of, or a preset over a core kind. The card and its form are data here; the machinery that acts on them is core, which is why a card may only name one of these five kinds.',
    schema: z.array(CapabilityContributionSchema),
} as const satisfies ContributionPoint;
