import { evaluateWhen, isWhenExpression, parseWhen } from "@intentic/base/when";
import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";
import { MARK_FIELDS } from "../mark.js";

// A field the "+" install dialog renders for a capability's config form (a slug key, a label, secret/optional
// flags, an optional select, a `when` gate). Mirrors the platform catalog's field shape so the web can render
// contributed cards from installed extensions exactly like core capability cards.
export const CapabilityFieldSchema = z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    secret: z.boolean().optional().describe("Mask it, and never echo it back."),
    optional: z.boolean().optional(),
    multiline: z.boolean().optional(),
    // An OPT-IN EXTRA rather than a decision, rendered as a switch, carried as the "on"/"off" the config
    // schemas already speak (the vpn's pfs/aggressive precedent). A two-option Segmented can express the same
    // value, and reads wrong for this: it presents a choice the user must make to proceed, sized like the
    // required fields around it. Something the capability works fine without wants the control that is quiet
    // when it is off. A switch always holds one of its two values, so such a field never blocks a submit
    // whatever `optional` says.
    boolean: z
        .boolean()
        .optional()
        .describe(
            'Render it as a switch, carrying "on"/"off". For an opt-in EXTRA rather than a decision: a two-option picker says the same thing but presents a choice the user must make to proceed, sized like the required fields around it. A switch always holds a value, so a field like this never blocks a submit.',
        ),
    // A line under the control, for what the user cannot see from the label alone (a host requirement, when a
    // value takes effect). The card's `hint` speaks for the whole card; this one is bound to the field it
    // qualifies, which is where a per-option caveat has to sit to be read at all.
    hint: z
        .string()
        .optional()
        .describe(
            "A line under this control, for what the label alone cannot say: a host requirement, when a value takes effect. The card's own `hint` speaks for the whole card; this one is bound to the field it qualifies.",
        ),
    /* This field's value only takes effect after the sandbox is REBUILT, it rides the environment overlay
     * rather than something the daemon can act on now. Rendered as a chip beside the label.
     *
     * The one fact a user needs before touching a control, and the one the form cannot infer: two switches
     * side by side, identical in every visible way, can cost five seconds and five minutes. The docker card
     * has exactly that pair (its GPU option is baked into the image; its engine options are a file dockerd
     * rereads), and without this flag the only way to find out which you pressed is to press it. */
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
    /* Gates this field on the answers already given, the SSH credential that only applies to the auth mode
     * chosen, the gateway fields that belong to one VPN provider. A `when` condition (@intentic/base/when)
     * evaluated against the form's live values, so it re-reads as the user toggles.
     *
     * Refused at parse when it does not parse. A card is data an extension ships, and a condition nobody can
     * evaluate is not a field that is always shown or always hidden, it is a card whose author believes it
     * asks something it never asks. Failing the manifest names the card; failing at render names nothing. */
    when: z
        .string()
        .refine(isWhenExpression, { message: "not a valid `when` condition" })
        .optional()
        .describe(
            "Only show this field while a condition over the answers already given holds: `auth == 'key'`, `provider in ['ipsec', 'fortinet']`, `!advanced`. Supports `&&`, `||`, `!`, comparisons and `in`.",
        ),
    // A fixed value baked into the config rather than asked for, how a card pins a discriminator
    // (platform="reddit", provider="stripe"). Rendered as nothing; sent as itself.
    value: z
        .string()
        .optional()
        .describe(
            'A fixed value baked into the config rather than asked for: how a card pins its discriminator (platform="reddit", provider="stripe"). Renders as nothing.',
        ),
    /* This field holds a TOTP seed, the base32 key (or otpauth:// URI) a service shows when enrolling an
     * authenticator app. Declare it WITH `secret: true`: the seed is a durable second factor, so it is never
     * echoed and, unlike an ordinary secret, never enters the agent's environment either, the daemon mints the
     * six-digit codes on demand (`otp <name>` / GET /capabilities/<id>/otp) and only those cross, each dead
     * within its period. A cli entry whose env references a totp field therefore fails to parse (see below). */
    totp: z
        .boolean()
        .optional()
        .describe(
            "This field holds a TOTP seed, the base32 key or otpauth:// URI a service shows when enrolling an authenticator app. Declare it with `secret: true`. Unlike an ordinary secret it never enters the agent's environment: the daemon mints the six-digit codes on demand and only those cross.",
        ),
});
export type CapabilityField = z.infer<typeof CapabilityFieldSchema>;

/* WHETHER A FIELD IS IN PLAY, given what has been answered so far, and the only place that decides it.
 *
 * Two tiers ask this question about the same card. The web's form asks it to decide what to draw and what to
 * validate; the daemon asks it at install to decide which fields it may demand. They used to answer it with
 * their own copies of the same comparison, in different packages, and the answers only had to diverge once for
 * a card to become unusable in exactly one direction: a field the form never showed, refused at submit for
 * being empty. Nothing in either copy referred to the other, so the divergence would have arrived as a bug
 * report about one card rather than as a broken rule.
 *
 * It lives beside the schema for the reason the description does: this is a fact about the shape, and the two
 * consumers are in different packages. Parsed per call rather than cached, a card has a handful of fields,
 * this runs on a keystroke at worst, and a cache keyed by manifest strings is a map that outlives every
 * extension that ever declared one. */
export const fieldApplies = (field: CapabilityField, values: Readonly<Record<string, unknown>>): boolean =>
    field.when === undefined || evaluateWhen(parseWhen(field.when), values);

// The "+" card an entry renders: how it looks in the grid and how the user gets the credential it asks for.
// Shared by every arm below, because none of that varies with the kind.
const CatalogSchema = z.object({
    name: z.string().min(1),
    ...MARK_FIELDS,
    // ONE LINE, aim for 60 characters or fewer. The grid clamps this at two lines and a card sits beside two
    // others in a pane the index column has already taken 16rem out of, so a paragraph here is a paragraph the
    // reader gets truncated. Everything longer belongs in `hint`, which the config form prints in full and the
    // catalog's search reads. Not capped in the schema: an extension published before this rule should still
    // install, and a card that reads badly is a worse outcome than one that fails to load only in theory.
    description: z
        .string()
        .min(1)
        .describe(
            "ONE LINE: aim for 60 characters or fewer. The grid clamps it at two lines in a narrow pane, so a paragraph here is a paragraph the reader gets truncated. Everything longer belongs in `hint`.",
        ),
    category: z.string().min(1),
    // The paragraph. Shown under the add-form, and searched from the catalog, so the words that identify this
    // card to someone hunting for it ("webauthn", "socket mode") belong here even when the tile can't show them.
    hint: z
        .string()
        .optional()
        .describe(
            'The paragraph, shown under the add form and searched from the catalog, so the words that identify this card to someone hunting for it ("webauthn", "socket mode") belong here even when the tile cannot show them.',
        ),
    // The credential-creation walkthrough the install dialog renders (the platform catalog's guide shape).
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

// Every arm carries these: the slug that becomes the card's /capabilities/<id> route AND the discriminator
// value the daemon's handler resolves (a cli `provider`, a browser/host `platform`), plus the card and its form.
const contributionBase = {
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    catalog: CatalogSchema,
    fields: z.array(CapabilityFieldSchema),
};

/* A CAPABILITY CARD AS DATA. The catalog is the extensible layer; the HANDLERS are core, so an entry names one
 * of the kinds whose daemon-side machinery is fully generic over its data, and the machinery stays put. The
 * kinds NOT listed here are the ones whose card is one-to-one with a handler that owns real privilege (`docker`
 * bakes --privileged, `vpn` bakes NET_ADMIN, `extension` installs extensions, `devops` scaffolds repos): their
 * cards live in the platform catalog because separating card from handler would split one concept in two, and
 * because a manifest that could name them would be a manifest that grants itself privilege. That restriction is
 * this discriminated union, not a comment, a manifest naming any other kind fails to parse.
 *
 * `${id}` in a cli/host skill file is substituted with the instance name at apply time (so a host pack's tool
 * names read `mcp__my-laptop__run_command`), and, for `cli`, each `$ENVVAR` becomes its per-instance suffixed
 * name. A BROWSER pack's skill renders once per SITE rather than per instance, its seams are `${accounts}`
 * (the roster of connected accounts), `${tools}` (the core driving/connecting note) and `${site}` (the host,
 * for the generic card whose text can name no site of its own); `${id}` and per-field substitution do not
 * apply there (capabilities/account-skills.ts in the sandbox daemon). */
export const CapabilityContributionSchema = z
    .discriminatedUnion("kind", [
        // A CLI tool the AGENT gets, authenticated: the env vars its shell receives (value templates over the
        // fields, `${field}` substitutes, `${field:uri}` percent-encodes), a SKILL.md cheatsheet, and an optional
        // image fragment holding the client binary (psql, mysql, whisper).
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
        }),
        /* A site the agent acts on AS THE OWNER, through the shared logged-in Chromium. `loginUrl` is what the
         * sign-in window opens; the profile it persists is the credential. `homeUrl` is where that same profile
         * opens once it HAS one, the owner's own hands on the connected browser, which a login page is the wrong
         * place to start (signed in, it only redirects). Two fields because for some platforms the login lives on
         * another site entirely (YouTube signs in at accounts.google.com), so one cannot be derived from the other.
         * No `env` and no `fragment`: the browser itself is core (one Chromium install serves every platform),
         * only the identity is per-entry. A card never declares the account's username/password either, those are
         * CORE form fields on every browser card (the catalog appends them; the daemon's add validation accepts
         * them), because which box a login form wants filled is the same fact on every site.
         *
         * BOTH URLs ARE OPTIONAL, so that one card can be the GENERIC one: a site card pins them (Reddit knows
         * where Reddit signs in), and the generic "browser session" card asks for them on its form instead, which
         * is what lets a user connect a site nobody shipped a card for. A card must do one or the other, pin a
         * URL or declare a field that supplies it, and the daemon's apply says so on the form when neither does,
         * because the alternative is a sign-in window that opens on nothing. */
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
        // An operating system a connected computer can run, the skill pack that teaches the agent THAT machine's
        // shell. The enrollment, the socket and the scope enforcement are core; only the pack varies.
        z.object({
            ...contributionBase,
            kind: z.literal("host"),
            skill: z.string().min(1).describe("Checkout-relative SKILL.md teaching the agent that machine's shell."),
        }),
        /* A PRESET over a core kind: no payload at all, just a named card whose `fields` carry the defaults. What an
         * ACP agent needs is a command, so "OpenCode" is entirely a name, a logo and a filled-in form, which is
         * exactly what a catalog row is. */
        z.object({ ...contributionBase, kind: z.literal("agent") }),
    ])
    .superRefine((spec, ctx) => {
        // The totp flag's one invariant, enforced where the manifest is parsed rather than trusted to authors: a
        // seed the daemon mints codes from must never ride the env into the agent's shell, that would hand the
        // agent the second factor itself instead of one expiring code at a time.
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
// The arms carrying a per-instance SKILL.md, the daemon templates and installs these identically.
export type SkillContribution = Extract<CapabilityContribution, { skill: string }>;

/* The config key a kind's cards PIN to their own id, so a stored capability can be traced back to the card that
 * made it, the daemon resolves the entry's handler data through it, and the web tells one card's instances from
 * another's. `agent` has none on purpose: its cards are presets over one config shape, differing only in their
 * defaults, so every agent instance belongs to every agent card equally.
 *
 * Here, beside the schema, because it is a fact about the contribution shape, the daemon, the catalog and the
 * web all need it, and three copies of it is three chances for a card's instances to go missing. `satisfies`
 * rather than a lookup table so a new arm above is a compile error until this answers for it. */
const DISCRIMINATOR = { cli: "provider", browser: "platform", host: "platform", agent: undefined } satisfies Record<
    CapabilityContribution["kind"],
    string | undefined
>;
export const contributionDiscriminator = (kind: string): string | undefined => DISCRIMINATOR[kind as keyof typeof DISCRIMINATOR];

export const capabilitiesPoint = {
    name: "capabilities",
    description:
        'Capability cards this pack adds to the "+" grid: a connected CLI tool, a site the agent acts on as the owner through the shared browser, an operating system pack, or a preset over a core kind. The card and its form are data here; the machinery that acts on them is core, which is why a card may only name one of these four kinds.',
    schema: z.array(CapabilityContributionSchema),
} as const satisfies ContributionPoint;
