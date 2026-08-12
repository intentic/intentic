import { join } from "node:path";
import { type CapabilityContribution, contributionDiscriminator, fieldApplies } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { enabledExtensions, type ExtensionHost, type InstalledExtension } from "../extensions/installed-extensions.js";
import type { CapabilityCtx } from "./capability.js";
import { extensionRead } from "./extension-dirs.js";

/* CAPABILITY CARDS AS DATA. A card's name, logo, form, skill, env and image fragment come from an installed
 * extension's `contributes.capabilities`, not a hardcoded daemon table — so a new connector, a new social
 * platform or a new OS pack is one manifest entry plus a markdown file, and no daemon change. The HANDLERS are
 * core and stay core (see registry.ts): what an extension supplies is what varies between two cards of the same
 * kind, never the machinery that acts on it.
 *
 * Entries are keyed `<kind>:<id>` because the id only has to be unique within a kind — `postgres` the cli
 * connector and a hypothetical `postgres` browser card are different cards, and install-time validation is
 * per-kind for the same reason. First declaration wins, so a first-party baked extension can't be shadowed. */

export interface ResolvedContribution {
    readonly spec: CapabilityContribution;
    // The extension that declared it: its dir is what skill/fragment paths resolve against, and whether its
    // code is in this image at all is what the card's status has to answer for — a core image bakes the
    // messaging manifests, so the cards exist there with nothing behind them.
    readonly extension: InstalledExtension;
}

export const contributionKey = (kind: CapabilityKind, id: string): string => `${kind}:${id}`;

// The narrow handler ctx as the extension enumerator's host — same fields, extensionsDir threaded through the
// ctx, so a handler builds the registry without holding Services.
export const hostOf = (ctx: CapabilityCtx): ExtensionHost => ({
    workspace: ctx.workspace,
    files: ctx.files,
    capabilities: ctx.capabilities,
    config: { extensionsDir: ctx.extensionsDir },
});

export const contributionRegistry = async (host: ExtensionHost): Promise<Map<string, ResolvedContribution>> => {
    const registry = new Map<string, ResolvedContribution>();
    for (const extension of await enabledExtensions(host)) {
        for (const spec of extension.manifest.contributes?.capabilities ?? []) {
            const key = contributionKey(spec.kind, spec.id);
            if (!registry.has(key)) {
                registry.set(key, { spec, extension });
            }
        }
    }
    return registry;
};

// The card a capability entry came from: its kind plus whatever its kind pins as the discriminator (a cli/
// integration `provider`, a browser/host `platform`). Undefined for a kind with no discriminator, or when the
// extension declaring it is gone or switched off — which is what makes an orphaned entry visible rather than silent.
export const contributionFor = (
    registry: Map<string, ResolvedContribution>,
    kind: CapabilityKind,
    config: Record<string, unknown>,
): ResolvedContribution | undefined => {
    const key = contributionDiscriminator(kind);
    if (key === undefined) {
        return undefined;
    }
    return registry.get(contributionKey(kind, String(config[key])));
};

// Expand a cli connector's env templates against a config: `${field}` substitutes the value, `${field:uri}`
// percent-encodes it (the one non-trivial case — a postgres URL). An absent field yields "".
export const contributionEnv = (spec: CapabilityContribution, config: Record<string, string>): Record<string, string> => {
    const env: Record<string, string> = {};
    if (spec.kind !== "cli") {
        return env;
    }
    for (const [key, template] of Object.entries(spec.env)) {
        env[key] = template.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)(:uri)?\}/g, (_match, field: string, uri: string | undefined) => {
            const value = config[field] ?? "";
            return uri === undefined ? value : encodeURIComponent(value);
        });
    }
    return env;
};

/* Every field a card marks `secret` — what must never be echoed back to the browser (see echoConfig). A card can
 * carry more than one: Slack needs an app-level token to open its socket AND a bot token for the Web API, and
 * neither belongs in a CapabilitySummary. */
export const contributionSecretFields = (spec: CapabilityContribution): Set<string> =>
    new Set(spec.fields.filter((field) => field.secret === true).map((field) => field.key));

// The credential a user ROTATES — the /secrets inventory key, revealed and replaced through that page. The
// FIRST secret field when a card declares several (Slack's bot token, the one that expires in practice);
// rotating a secondary one is a re-add of the capability, as it is for an ipsec tunnel's PSK. undefined when a
// card carries no secret.
export const contributionSecretField = (spec: CapabilityContribution): string | undefined => spec.fields.find((field) => field.secret === true)?.key;

/* WHERE A CONNECTED BROWSER OPENS — the sign-in page for a login window, the home page for the owner's own
 * visit — resolved for ONE instance, because the two kinds of browser card answer it in different places: a site
 * card pins both in its manifest (Reddit knows where Reddit signs in), and the generic session card asks for them
 * on its form, which is what lets a user connect a site nobody shipped a card for. Config wins over the manifest,
 * so a preset can still be pointed at a different instance of the same software (a self-hosted GitLab).
 *
 * Either one alone is enough and each falls back to the other: most sites sign in on the page they live on, and
 * asking a user to type the same URL twice to prove it would be a form that reads as broken. undefined means
 * NEITHER was answered — the one case that cannot be papered over, since the login window would open on nothing;
 * the browser handler turns it into a failed add so the reader sees it on the form they are still standing on. */
export interface BrowserUrls {
    readonly loginUrl: string;
    readonly homeUrl: string;
}

export const browserUrls = (spec: CapabilityContribution, config: Record<string, string>): BrowserUrls | undefined => {
    if (spec.kind !== "browser") {
        return undefined;
    }
    const home = config["homeUrl"] ?? spec.homeUrl;
    const login = config["loginUrl"] ?? spec.loginUrl;
    return login === undefined && home === undefined ? undefined : { loginUrl: login ?? home!, homeUrl: home ?? login! };
};

// The checkout-relative fragment path as absolute — cli only, and only when it declares one.
export const contributionFragmentPath = (contribution: ResolvedContribution): string | undefined =>
    contribution.spec.kind === "cli" && contribution.spec.fragment !== undefined
        ? join(contribution.extension.dir, contribution.spec.fragment)
        : undefined;

/* THE CARD'S SKILL.md, read and rendered for ONE instance. Three substitutions, the same for every kind:
 *   `${tools}`   → the kind's core tool-surface note (how to drive the shared browser, what a connected
 *                  computer's tools are and what a refused scope means) — core because the tools are, and
 *                  because a note duplicated across N platform packs is a note that drifts;
 *   `${id}`      → this instance's name, so the examples are copy-pasteable rather than illustrative;
 *   `${<field>}` → whatever the user answered on the card's form, the same spelling cli's env templates use.
 *
 * The field pass is what lets ONE pack serve a card that knows nothing about its site: the generic browser
 * session's cheatsheet names the page and the purpose the user typed, so the agent can tell which account it is
 * holding and when to reach for it — facts a site pack hardcodes and a generic one cannot. Fields substitute
 * into the FRONTMATTER too, which is the point: `description` is what the agent routes on, and a generic skill
 * whose description said nothing about the site would never be picked for it. An unanswered optional field
 * yields "" rather than the literal `${...}`, so a template can reference one without demanding it.
 *
 * A `secret` FIELD IS NEVER SUBSTITUTED. A skill file is plain text in the workspace that the agent reads every
 * turn and that a `cli` pack could reference by name; copying a token into one would spread a credential from the
 * one place it is guarded (the manifest, on the secret denylist) into a place nothing guards. Such a reference
 * renders empty — visibly wrong in the pack, rather than quietly leaking.
 *
 * The frontmatter `name:` becomes the (unique) instance id last, so two instances of one card never register
 * the same skill name. cli's extra `$VAR` → `$VAR_<SUFFIX>` pass is its own, and stays in its handler.
 *
 * Undefined means the file is missing from the checkout — a rotted install, which every caller turns into a
 * failed add rather than an empty skill the agent would silently read as "this tool does nothing". */
export const contributedSkill = async (
    contribution: ResolvedContribution,
    id: string,
    tools: string,
    config: Record<string, string> = {},
): Promise<string | undefined> => {
    if (!("skill" in contribution.spec)) {
        return undefined;
    }
    const source = await extensionRead(join(contribution.extension.dir, contribution.spec.skill));
    if (source === undefined) {
        return undefined;
    }
    // `${tools}` first, so a note may itself reference `${id}`; fields last, and only the ones the card DECLARED —
    // a template can't reach a key the form never showed, and `${tools}`/`${id}` can't be shadowed by a field. A
    // secret field is substituted with NOTHING rather than skipped: left as the literal `${token}` it would still
    // be safe, but it would sit in the agent's context looking like a value it was supposed to find.
    const secrets = contributionSecretFields(contribution.spec);
    const fields = contribution.spec.fields.map((field) => field.key).filter((key) => key !== "tools" && key !== "id");
    let rendered = source.replaceAll("${tools}", tools).replaceAll("${id}", id);
    for (const key of fields) {
        rendered = rendered.replaceAll(`\${${key}}`, secrets.has(key) ? "" : (config[key] ?? ""));
    }
    return rendered.replace(/^name: .*$/m, `name: ${id}`);
};

/* Validate a capability's config against the card's declared fields: required (non-optional, no `when` unmet)
 * fields must be present and non-empty; unknown keys are rejected; `options` fields must hold a listed value.
 * The kind's discriminator is allowed on top of the declared fields — the core injects it, the card doesn't
 * declare it. Returns an error message, or undefined when valid. */
export const validateContributionConfig = (spec: CapabilityContribution, config: Record<string, string>): string | undefined => {
    const discriminator = contributionDiscriminator(spec.kind);
    const declared = new Set(spec.fields.map((field) => field.key));
    if (discriminator !== undefined) {
        declared.add(discriminator);
    }
    // Every browser card takes the account's sign-in credentials, whether or not it declared fields: which box a
    // login form wants filled is the same fact on every site, and they are what the accounts tools type for the
    // agent (the password doubles as the entry's secret). Core here rather than declared per card so a site
    // extension cannot forget them — the form offers them on all browser cards alike. `identity` is core for the
    // same reason: WHICH identity an account is born from is a fact about the sandbox's manifest, not about any
    // site, and it is what files the account into that identity's shared browser.
    // `purpose` and `openedAt` join them as the account's own history — what it was opened for and when. Same
    // argument: a fact about this sandbox's account, not about the site, and every pinned-URL card declares no
    // fields at all, so a per-card declaration would mean no site card could ever carry them.
    if (spec.kind === "browser") {
        declared.add("username").add("password").add("identity").add("purpose").add("openedAt");
    }
    const unknown = Object.keys(config).filter((key) => !declared.has(key));
    if (unknown.length > 0) {
        return `unknown ${spec.id} field(s): ${unknown.join(", ")}`;
    }
    for (const field of spec.fields) {
        if (!fieldApplies(field, config)) {
            continue;
        }
        const value = config[field.key];
        // A field with a `default` or a pinned `value` fills itself, so it's effectively optional at add-time.
        const required = field.optional !== true && field.default === undefined && field.value === undefined;
        if (required && (value === undefined || value === "")) {
            return `${spec.id} requires "${field.key}"`;
        }
        if (value !== undefined && field.options !== undefined && value !== "" && !field.options.some((option) => option.value === value)) {
            return `${spec.id} field "${field.key}" must be one of: ${field.options.map((option) => option.value).join(", ")}`;
        }
    }
    return undefined;
};
