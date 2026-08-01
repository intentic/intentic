import { join } from "node:path";
import type { ConnectorContribution } from "@intentic/extension-api";
import { enabledExtensions, type ExtensionHost } from "../../extensions/installed-extensions.js";

/* CLI connectors as DATA: a provider's card/fields/env/skill/fragment come from an installed extension's
 * `contributes.connectors`, not a hardcoded daemon table. The registry resolves a `cli` capability's provider
 * to its spec (+ the extension dir the skill/fragment paths are relative to), so adding a connector is one
 * manifest entry + two files in an extension repo — no daemon change. Provider names are unique across
 * installed extensions (install-time validated); a first-party baked extension can't be shadowed. */

export interface ResolvedConnector {
    readonly spec: ConnectorContribution;
    // The extension's checkout/bake dir — skill/fragment paths resolve against it.
    readonly dir: string;
}

export const connectorRegistry = async (host: ExtensionHost): Promise<Map<string, ResolvedConnector>> => {
    const registry = new Map<string, ResolvedConnector>();
    for (const extension of await enabledExtensions(host)) {
        for (const spec of extension.manifest.contributes?.connectors ?? []) {
            if (!registry.has(spec.provider)) {
                registry.set(spec.provider, { spec, dir: extension.dir });
            }
        }
    }
    return registry;
};

// Expand a connector's env templates against a config: `${field}` substitutes the value, `${field:uri}`
// percent-encodes it (the one non-trivial case — a postgres URL). An absent field yields "".
export const connectorEnv = (spec: ConnectorContribution, config: Record<string, string>): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, template] of Object.entries(spec.env)) {
        env[key] = template.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)(:uri)?\}/g, (_match, field: string, uri: string | undefined) => {
            const value = config[field] ?? "";
            return uri === undefined ? value : encodeURIComponent(value);
        });
    }
    return env;
};

/* Every field a connector marks `secret` — what must never be echoed back to the browser (see echoConfig). A
 * connector can carry more than one: Slack needs an app-level token to open its socket AND a bot token for the
 * Web API, and neither belongs in a CapabilitySummary. */
export const connectorSecretFields = (spec: ConnectorContribution): Set<string> =>
    new Set(spec.fields.filter((field) => field.secret === true).map((field) => field.key));

// The credential a user ROTATES — the /secrets inventory key, revealed and replaced through that page. The
// FIRST secret field when a connector declares several (Slack's bot token, the one that expires in practice);
// rotating a secondary one is a re-add of the capability, as it is for an ipsec tunnel's PSK. undefined when a
// connector carries no secret.
export const connectorSecretField = (spec: ConnectorContribution): string | undefined => spec.fields.find((field) => field.secret === true)?.key;

// The checkout-relative skill/fragment paths as absolute.
export const connectorSkillPath = (connector: ResolvedConnector): string => join(connector.dir, connector.spec.skill);
export const connectorFragmentPath = (connector: ResolvedConnector): string | undefined =>
    connector.spec.fragment === undefined ? undefined : join(connector.dir, connector.spec.fragment);

// Validate a cli capability's config against the connector's declared fields: required (non-optional, no
// `when` unmet) fields must be present and non-empty; unknown keys (beyond `provider` + declared fields) are
// rejected; `options` fields must hold a listed value. Returns an error message, or undefined when valid.
export const validateConnectorConfig = (spec: ConnectorContribution, config: Record<string, string>): string | undefined => {
    const declared = new Set(spec.fields.map((field) => field.key));
    const unknown = Object.keys(config).filter((key) => key !== "provider" && !declared.has(key));
    if (unknown.length > 0) {
        return `unknown ${spec.provider} field(s): ${unknown.join(", ")}`;
    }
    for (const field of spec.fields) {
        if (field.when !== undefined && config[field.when.key] !== field.when.value) {
            continue;
        }
        const value = config[field.key];
        // A field with a `default` fills itself, so it's effectively optional at add-time.
        const required = field.optional !== true && field.default === undefined;
        if (required && (value === undefined || value === "")) {
            return `${spec.provider} requires "${field.key}"`;
        }
        if (value !== undefined && field.options !== undefined && value !== "" && !field.options.some((option) => option.value === value)) {
            return `${spec.provider} field "${field.key}" must be one of: ${field.options.map((option) => option.value).join(", ")}`;
        }
    }
    return undefined;
};
