import { join } from "node:path";
import { type CapabilityContribution, contributionDiscriminator, fieldApplies } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { enabledExtensions, type ExtensionHost, type InstalledExtension } from "../extensions/installed-extensions.js";
import type { CapabilityCtx } from "./capability.js";
import { extensionRead } from "./extension-dirs.js";

// Capability entries are data: name, logo, form, skill, env and image fragment come from an installed extension's
// `contributes.capabilities`, not a hardcoded table. Handlers stay core; the manifest supplies only what varies between
// two entries of one kind. Entries key by `<kind>:<id>` (unique only within a kind); first declaration wins.

export interface ResolvedContribution {
    readonly spec: CapabilityContribution;
    // Declaring extension: skill/fragment paths resolve against its dir; presence answers the entry's status.
    readonly extension: InstalledExtension;
}

export const contributionKey = (kind: CapabilityKind, id: string): string => `${kind}:${id}`;

// Adapts a handler's narrow ctx into the extension enumerator's host shape, so a handler can build the registry without
// holding Services.
export const hostOf = (ctx: CapabilityCtx): ExtensionHost => ({
    workspace: ctx.workspace,
    files: ctx.files,
    capabilities: ctx.capabilities,
    config: { extensionsDir: ctx.extensionsDir, historyRoot: ctx.historyRoot },
});

const buildRegistry = async (host: ExtensionHost): Promise<ReadonlyMap<string, ResolvedContribution>> => {
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

// One inventory per capability store and workspace, kept until something it was read from changes: every turn, every
// door request and every capabilities list reads it, and each build reads and parses every installed manifest. The
// daemon calls invalidateContributions when an extension's source, the enablement file or the capability manifest is
// written (bootstrap/change-reactions.ts, composition.ts) and whenever the extension set moves, which is every call of
// the backend supervisor's restart (an install, a toggle, a removal, an approval). Keyed by
// the store object too, so two stores over one root (a test's, the daemon's raw and vaulted ones) never share.
interface Cached {
    readonly generation: number;
    readonly value: Promise<unknown>;
}
const inventories = new WeakMap<object, Map<string, Cached>>();
let generation = 0;

// Whatever an inventory was built from may have changed: the next read builds afresh.
export const invalidateContributions = (): void => {
    generation += 1;
};

// A capability store whose every write invalidates the inventory.
export const invalidatingContributions = <S extends { readonly upsert: (value: never) => Promise<void>; readonly remove: (id: string) => Promise<boolean> }>(
    store: S,
): S => ({
    ...store,
    upsert: async (value: Parameters<S["upsert"]>[0]) => {
        try {
            await store.upsert(value);
        } finally {
            invalidateContributions();
        }
    },
    remove: async (id: string) => {
        try {
            return await store.remove(id);
        } finally {
            invalidateContributions();
        }
    },
});

// One cached build per store, workspace and slot, rebuilt once anything moved since.
const cachedFor = <T>(host: ExtensionHost, slot: string, build: () => Promise<T>): Promise<T> => {
    const byStore = inventories.get(host.capabilities) ?? new Map<string, Cached>();
    inventories.set(host.capabilities, byStore);
    const key = `${slot}\u0000${host.workspace.root}\u0000${host.config.extensionsDir}`;
    const cached = byStore.get(key);
    if (cached !== undefined && cached.generation === generation) {
        return cached.value as Promise<T>;
    }
    const built: Cached = { generation, value: build() };
    byStore.set(key, built);
    // A failed build is forgotten, so the next read tries again rather than inheriting the failure.
    built.value.catch(() => {
        if (byStore.get(key) === built) {
            byStore.delete(key);
        }
    });
    return built.value as Promise<T>;
};

export const contributionRegistry = (host: ExtensionHost): Promise<ReadonlyMap<string, ResolvedContribution>> =>
    cachedFor(host, "contributions", () => buildRegistry(host));

// The enabled extensions themselves, from the same cache: what serves extension-level tools, and what the /x refusal
// and the door read a manifest from.
export const cachedEnabledExtensions = (host: ExtensionHost): Promise<readonly InstalledExtension[]> =>
    cachedFor(host, "enabled", () => enabledExtensions(host));

// Looks up the entry by the kind's discriminator field (a cli `provider`, a browser `platform`); undefined if the kind
// has none, or the declaring extension is missing or disabled.
export const contributionFor = (
    registry: ReadonlyMap<string, ResolvedContribution>,
    kind: CapabilityKind,
    config: Record<string, unknown>,
): ResolvedContribution | undefined => {
    const key = contributionDiscriminator(kind);
    if (key === undefined) {
        return undefined;
    }
    return registry.get(contributionKey(kind, String(config[key])));
};

// Expands a cli connector's env templates: `${field}` substitutes the config value, `${field:uri}` percent-encodes it.
// An absent field yields "".
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

// Fields a entry marks `secret`; must never be echoed back to the browser. A entry may declare more than one (Slack needs
// both an app-level and a bot token).
export const contributionSecretFields = (spec: CapabilityContribution): Set<string> =>
    new Set(spec.fields.filter((field) => field.secret === true).map((field) => field.key));

// The credential rotated via /secrets: the first field marked secret when a entry declares several; undefined if none.
// Rotating any other secret field means re-adding the capability.
export const contributionSecretField = (spec: CapabilityContribution): string | undefined => spec.fields.find((field) => field.secret === true)?.key;

// Resolves login/home URLs for one browser instance: config overrides the manifest, and either field alone fills both
// via fallback. Undefined only if neither is set.
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

// The fragment path made absolute (checkout-relative in the manifest), cli entries only.
export const contributionFragmentPath = (contribution: ResolvedContribution): string | undefined =>
    contribution.spec.kind === "cli" && contribution.spec.fragment !== undefined
        ? join(contribution.extension.dir, contribution.spec.fragment)
        : undefined;

// The feature pack name a cli contribution references in place of shipping its own fragment, for a base image that
// already bakes the tool.
export const contributionPackName = (contribution: ResolvedContribution): string | undefined =>
    contribution.spec.kind === "cli" ? contribution.spec.pack : undefined;

// Renders a entry's skill.md for one instance. Substitutions, in order:
//   `${tools}` → the kind's tool-surface note
//   `${id}` → this instance's id
//   `${<field>}` → the declared field's config value, "" if unanswered
// A `secret` field always renders empty rather than its value. Fields substitute into the frontmatter too, and `name:`
// is overwritten with the instance id last. Returns undefined if the skill file is missing from the checkout.
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
    // Order matters: `${tools}` before `${id}` lets a tools note reference the id; only declared fields substitute.
    const secrets = contributionSecretFields(contribution.spec);
    const fields = contribution.spec.fields.map((field) => field.key).filter((key) => key !== "tools" && key !== "id");
    let rendered = source.replaceAll("${tools}", tools).replaceAll("${id}", id);
    for (const key of fields) {
        rendered = rendered.replaceAll(`\${${key}}`, secrets.has(key) ? "" : (config[key] ?? ""));
    }
    return rendered.replace(/^name: .*$/m, `name: ${id}`);
};

// Validates config against the entry's declared fields (required present, unknown rejected, `options` values checked);
// the kind's discriminator is allowed though undeclared. Returns an error message, or undefined when valid.
export const validateContributionConfig = (spec: CapabilityContribution, config: Record<string, string>): string | undefined => {
    const discriminator = contributionDiscriminator(spec.kind);
    const declared = new Set(spec.fields.map((field) => field.key));
    if (discriminator !== undefined) {
        declared.add(discriminator);
    }
    // These five are core to every browser entry, not per-card, since a pinned-URL entry declares no fields.
    if (spec.kind === "browser") {
        // `exit` belongs here too: which country the browser exits through is a sandbox fact, not a site fact.
        declared.add("username").add("password").add("identity").add("purpose").add("openedAt").add("exit");
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
        // A field with a `default` or a pinned `value` counts as satisfied, not required, at add time.
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
