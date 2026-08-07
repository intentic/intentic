import { join } from "node:path";
import { type CapabilityContribution, contributionDiscriminator } from "@intentic/extension-manifest";
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
export const contributionSecretField = (spec: CapabilityContribution): string | undefined =>
    spec.fields.find((field) => field.secret === true)?.key;

// The checkout-relative fragment path as absolute — cli only, and only when it declares one.
export const contributionFragmentPath = (contribution: ResolvedContribution): string | undefined =>
    contribution.spec.kind === "cli" && contribution.spec.fragment !== undefined
        ? join(contribution.extension.dir, contribution.spec.fragment)
        : undefined;

/* THE CARD'S SKILL.md, read and rendered for ONE instance. Two substitutions, the same for every kind:
 *   `${tools}` → the kind's core tool-surface note (how to drive the shared browser, what a connected
 *                computer's tools are and what a refused scope means) — core because the tools are, and
 *                because a note duplicated across N platform packs is a note that drifts;
 *   `${id}`    → this instance's name, so the examples are copy-pasteable rather than illustrative.
 * The frontmatter `name:` becomes the (unique) instance id last, so two instances of one card never register
 * the same skill name. cli's extra `$VAR` → `$VAR_<SUFFIX>` pass is its own, and stays in its handler.
 *
 * Undefined means the file is missing from the checkout — a rotted install, which every caller turns into a
 * failed add rather than an empty skill the agent would silently read as "this tool does nothing". */
export const contributedSkill = async (contribution: ResolvedContribution, id: string, tools: string): Promise<string | undefined> => {
    if (!("skill" in contribution.spec)) {
        return undefined;
    }
    const source = await extensionRead(join(contribution.extension.dir, contribution.spec.skill));
    return source === undefined ? undefined : source.replaceAll("${tools}", tools).replaceAll("${id}", id).replace(/^name: .*$/m, `name: ${id}`);
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
    const unknown = Object.keys(config).filter((key) => !declared.has(key));
    if (unknown.length > 0) {
        return `unknown ${spec.id} field(s): ${unknown.join(", ")}`;
    }
    for (const field of spec.fields) {
        if (field.when !== undefined && config[field.when.key] !== field.when.value) {
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
