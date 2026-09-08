import type { InventoryEntry, InventoryProvider, ServiceKind } from "@intentic/sandbox-contract";

// Renders/parses the platform-owned region between the markers in deploy.config.ts, regenerated wholesale from
// InventoryEntry (backend/service/app); user code outside is untouched. Name references (`on: self`) round-trip
// losslessly; wire schemas live in @intentic/sandbox-contract.

// ---- managed-region parser/renderer ----

const BEGIN_TAG = `// <intentic>`;
const END_TAG = `// </intentic>`;
const BEGIN_MARKER = `${BEGIN_TAG} managed: do not edit by hand`;
const INDENT = `    `;

type ServiceEntry = Extract<InventoryEntry, { kind: `service` }>;
type AppEntry = Extract<InventoryEntry, { kind: `app` }>;

// How one option is emitted: a provided value (string/number), or an env() secret reference.
interface FieldSpec {
    readonly key: string;
    readonly source: "string" | "number" | "env";
    readonly envVar?: string;
    // Emitted only when the entry carries a value; a default (e.g. "direct" transport) is omitted.
    readonly optional?: boolean;
}
interface ProviderSpec {
    readonly fields: readonly FieldSpec[];
}

// A host never reads its `envVar`; hostSshKeyEnvVar supplies a per-name var for every host, `self` included.
const REGISTRY: Record<InventoryProvider, ProviderSpec> = {
    host: {
        fields: [
            { key: `address`, source: `string` },
            { key: `user`, source: `string` },
            { key: `port`, source: `number` },
            // SSH transport; only written when non-default (e.g. "cloudflared" for a NAT'd self-host).
            { key: `via`, source: `string`, optional: true },
            // No `envVar`: hostSshKeyEnvVar answers for every host; a static one here would be an unread duplicate.
            { key: `sshKey`, source: `env` },
        ],
    },
    cloudflare: {
        fields: [
            { key: `apiToken`, source: `env`, envVar: `CLOUDFLARE_API_TOKEN` },
            // Zone picked at connect time, validates domains against it; omitted falls back to token-based discovery.
            { key: `zone`, source: `string`, optional: true },
        ],
    },
    github: {
        fields: [{ key: `token`, source: `env`, envVar: `GITHUB_TOKEN` }],
    },
    // Instance url is written only when non-default; owner/registry stay hand-authored, not modeled here.
    gitlab: {
        fields: [
            { key: `url`, source: `string`, optional: true },
            { key: `token`, source: `env`, envVar: `GITLAB_TOKEN` },
        ],
    },
    stripe: {
        fields: [{ key: `apiKey`, source: `env`, envVar: `STRIPE_API_KEY` }],
    },
};

// Field specs beyond kind/on/expose (rendered structurally); every catalog service takes just a domain.
const SERVICE_REGISTRY: Record<ServiceKind, ProviderSpec> = {
    signoz: { fields: [{ key: `domain`, source: `string` }] },
    outline: { fields: [{ key: `domain`, source: `string` }] },
    paperless: { fields: [{ key: `domain`, source: `string` }] },
    openproject: { fields: [{ key: `domain`, source: `string` }] },
    invoiceninja: { fields: [{ key: `domain`, source: `string` }] },
    infisical: { fields: [{ key: `domain`, source: `string` }] },
};

// Env var name for a host's SSH key: `<NAME>_SSH_KEY`, upper-cased; shared with the daemon's /enroll route so the two
// can't drift.
export const hostSshKeyVar = (name: string): string => `${name.toUpperCase()}_SSH_KEY`;

// Undefined for anything but a host's sshKey field; those fall back to their static envVar.
const hostSshKeyEnvVar = (entry: InventoryEntry, field: FieldSpec): string | undefined =>
    entry.kind === `backend` && entry.provider === `host` && field.key === `sshKey` ? hostSshKeyVar(entry.name) : undefined;

const renderOption = (entry: InventoryEntry, field: FieldSpec): string | undefined => {
    if (field.source === `env`) {
        return `${field.key}: env(${JSON.stringify(hostSshKeyEnvVar(entry, field) ?? field.envVar ?? ``)})`;
    }
    const value = entry.values[field.key];
    // Optional field with no value is omitted, not rendered as an empty literal.
    if (field.optional && (value === undefined || value === ``)) {
        return undefined;
    }
    if (field.source === `number`) {
        return `${field.key}: ${typeof value === `number` ? value : Number(value ?? 0)}`;
    }
    return `${field.key}: ${JSON.stringify(String(value ?? ``))}`;
};

const renderBackendEntry = (entry: Extract<InventoryEntry, { kind: `backend` }>): string => {
    const spec = REGISTRY[entry.provider];
    const options = spec.fields
        .map((field) => renderOption(entry, field))
        .filter((option): option is string => option !== undefined)
        .join(`, `);
    return `${INDENT}const ${entry.name} = i.have.${entry.provider}(${JSON.stringify(entry.name)}, { ${options} });`;
};

// References host/cloudflare bindings by bare identifier, not a quoted string, so generated TS reuses the backend
// entries' const bindings.
const renderServiceEntry = (entry: ServiceEntry): string => {
    const spec = SERVICE_REGISTRY[entry.service];
    const options = [
        `kind: ${JSON.stringify(entry.service)}`,
        `on: ${entry.on}`,
        `expose: ${entry.expose}`,
        ...spec.fields.map((field) => renderOption(entry, field)).filter((option): option is string => option !== undefined),
    ].join(`, `);
    return `${INDENT}const ${entry.name} = i.want.service(${JSON.stringify(entry.name)}, { ${options} });`;
};

// Wires on/expose like a service; the one production environment carries the domain, branch fixed to "main". Kept to
// one line for the region's line-based parse.
const renderAppEntry = (entry: AppEntry): string => {
    const domain = JSON.stringify(String(entry.values[`domain`] ?? ``));
    const options = `on: ${entry.on}, expose: ${entry.expose}, environments: { production: { domain: ${domain}, branch: "main" } }`;
    return `${INDENT}const ${entry.name} = i.want.app(${JSON.stringify(entry.name)}, { ${options} });`;
};

const renderEntry = (entry: InventoryEntry): string => {
    if (entry.kind === `service`) {
        return renderServiceEntry(entry);
    }
    if (entry.kind === `app`) {
        return renderAppEntry(entry);
    }
    return renderBackendEntry(entry);
};

const renderRegion = (entries: readonly InventoryEntry[]): string =>
    [`${INDENT}${BEGIN_MARKER}`, ...entries.map(renderEntry), `${INDENT}${END_TAG}`].join(`\n`);

// Rewrites the managed region in `src` to `entries`, replacing it if present or inserting one inside defineIntent's
// body; throws if there's no defineIntent to insert into.
export const writeManagedRegion = (src: string, entries: readonly InventoryEntry[]): string => {
    const lines = src.split(`\n`);
    const begin = lines.findIndex((line) => line.trim().startsWith(BEGIN_TAG));
    const end = lines.findIndex((line) => line.trim().startsWith(END_TAG));
    const region = renderRegion(entries).split(`\n`);

    if (begin !== -1 && end !== -1 && end > begin) {
        return [...lines.slice(0, begin), ...region, ...lines.slice(end + 1)].join(`\n`);
    }

    const open = lines.findIndex((line) => /defineIntent\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{/.test(line));
    if (open === -1) {
        throw new Error(`deploy.config.ts has no defineIntent((i) => { … }) body to insert the managed region into.`);
    }
    return [...lines.slice(0, open + 1), ...region, ``, ...lines.slice(open + 1)].join(`\n`);
};

// Best-effort parse of an option object into display values (`key: "string"`, `key: 123`); env() and bare-identifier
// references are skipped, not display values.
const parseValues = (optionsSrc: string): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const match of optionsSrc.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined) {
            values[key] = value;
        }
    }
    for (const match of optionsSrc.matchAll(/(\w+)\s*:\s*(-?\d+)\b/g)) {
        const key = match[1];
        const value = match[2];
        if (key !== undefined && value !== undefined && !(key in values)) {
            values[key] = Number(value);
        }
    }
    return values;
};

const KNOWN_PROVIDERS = new Set<string>(Object.keys(REGISTRY));
const KNOWN_SERVICES = new Set<string>(Object.keys(SERVICE_REGISTRY));

// Keeps only a service kind's known display fields from the parsed values; drops `kind`, which the parser also
// captured.
const serviceValues = (kind: ServiceKind, all: Record<string, string | number>): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const field of SERVICE_REGISTRY[kind].fields) {
        if (field.key in all) {
            values[field.key] = all[field.key] as string | number;
        }
    }
    return values;
};

// Parses i.have.* / i.want.service declarations in the managed region into structured entries; an unmodeled provider or
// service is skipped, left untouched.
export const readManagedRegion = (src: string): InventoryEntry[] => {
    const lines = src.split(`\n`);
    const begin = lines.findIndex((line) => line.trim().startsWith(BEGIN_TAG));
    const end = lines.findIndex((line) => line.trim().startsWith(END_TAG));
    if (begin === -1 || end === -1 || end <= begin) {
        return [];
    }

    const entries: InventoryEntry[] = [];
    for (const line of lines.slice(begin + 1, end)) {
        // Matches i.want.service("name", { kind, on, expose, ... }); on/expose are bare const references.
        const serviceMatch = /i\.want\.service\(\s*"([^"]+)"\s*,\s*\{(.*)\}\s*\)/.exec(line);
        if (serviceMatch) {
            const name = serviceMatch[1];
            const optionsSrc = serviceMatch[2];
            const kind = /\bkind\s*:\s*"([^"]+)"/.exec(optionsSrc ?? ``)?.[1];
            const on = /\bon\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            const expose = /\bexpose\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            if (
                name !== undefined &&
                optionsSrc !== undefined &&
                kind !== undefined &&
                KNOWN_SERVICES.has(kind) &&
                on !== undefined &&
                expose !== undefined
            ) {
                entries.push({
                    kind: `service`,
                    service: kind as ServiceKind,
                    name,
                    on,
                    expose,
                    values: serviceValues(kind as ServiceKind, parseValues(optionsSrc)),
                });
            }
            continue;
        }
        // Matches i.want.app("name", { on, expose, environments: { production: { domain, branch } } }).
        const appMatch = /i\.want\.app\(\s*"([^"]+)"\s*,\s*\{(.*)\}\s*\)/.exec(line);
        if (appMatch) {
            const name = appMatch[1];
            const optionsSrc = appMatch[2];
            const on = /\bon\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            const expose = /\bexpose\s*:\s*([a-zA-Z_]\w*)/.exec(optionsSrc ?? ``)?.[1];
            const domain = /\bdomain\s*:\s*"([^"]*)"/.exec(optionsSrc ?? ``)?.[1];
            if (name !== undefined && on !== undefined && expose !== undefined && domain !== undefined) {
                entries.push({ kind: `app`, name, on, expose, values: { domain } });
            }
            continue;
        }
        // Matches i.have.<provider>("name", { ... }).
        const match = /i\.have\.(\w+)\(\s*"([^"]+)"\s*,\s*\{(.*)\}\s*\)/.exec(line);
        const provider = match?.[1];
        const name = match?.[2];
        const optionsSrc = match?.[3];
        if (provider === undefined || name === undefined || optionsSrc === undefined || !KNOWN_PROVIDERS.has(provider)) {
            continue;
        }
        entries.push({ kind: `backend`, provider: provider as InventoryProvider, name, values: parseValues(optionsSrc) });
    }
    return entries;
};

// Fresh deploy.config.ts containing only the managed region; the base for a repo with no config yet, used by `init
// --minimal` and first-boot scaffold.
export const scaffoldDeployConfig = (entries: readonly InventoryEntry[]): string =>
    [
        `import { env } from "@intentic/graph";`,
        `import { defineIntent } from "@intentic/sdk";`,
        ``,
        `export const intent = defineIntent((i) => {`,
        renderRegion(entries),
        ``,
        `});`,
        ``,
    ].join(`\n`);
