import type { InventoryEntry, InventoryProvider, ServiceKind } from "@intentic/sandbox-contract";

/* The platform-owned region of an intent's deploy.config.ts. Everything between the markers is regenerated
 * wholesale from the structured inventory entries, so the UI can edit the file deterministically; the user's
 * code outside the markers is never touched. The sandbox owns this (the browser calls the daemon's /inventory
 * routes directly).
 *
 * Three entry shapes live in the region: `backend` (i.have.<provider>(...), host/cloudflare/github/stripe),
 * `service` (i.want.service(...), an authorable shared tool like SigNoz) and `app` (i.want.app(...), a
 * deployable app, single production environment on `main`). Services and apps reference an existing host +
 * cloudflare binding by NAME, rendered as bare const references (`on: self`), and parsed back to those
 * names, the render→parse cycle must be lossless so repeated edits never mangle a user's entries.
 *
 * The inventory wire schemas (InventoryEntry / AddInventoryInputSchema / the provider + service enums) live in
 * @intentic/sandbox-contract, the single source the daemon and the browser client both validate against. This
 * module only renders/parses those entries to and from TypeScript. */

// ---- managed-region parser/renderer ----

const BEGIN_TAG = `// <intentic>`;
const END_TAG = `// </intentic>`;
const BEGIN_MARKER = `${BEGIN_TAG} managed: do not edit by hand`;
const INDENT = `    `;

type ServiceEntry = Extract<InventoryEntry, { kind: `service` }>;
type AppEntry = Extract<InventoryEntry, { kind: `app` }>;

// How one option is emitted: from a provided value (string/number), or as an env() secret reference.
interface FieldSpec {
    readonly key: string;
    readonly source: "string" | "number" | "env";
    readonly envVar?: string;
    // An optional field is emitted only when the entry actually carries a value, so a default like a host's
    // "direct" transport isn't written as an empty literal that would fail the provider's enum on re-read.
    readonly optional?: boolean;
}
interface ProviderSpec {
    readonly fields: readonly FieldSpec[];
}

// Cloudflare/github/stripe use fixed env-var names (a single account each). Hosts get a PER-NAME ssh-key var (see
// hostSshKeyEnvVar) so multiple deploy targets don't collide; the `envVar` here is the `self` fallback.
const REGISTRY: Record<InventoryProvider, ProviderSpec> = {
    host: {
        fields: [
            { key: `address`, source: `string` },
            { key: `user`, source: `string` },
            { key: `port`, source: `number` },
            // SSH transport; only written when non-default (e.g. "cloudflared" for a NAT'd self-host).
            { key: `via`, source: `string`, optional: true },
            { key: `sshKey`, source: `env`, envVar: `HOST_SSH_KEY` },
        ],
    },
    cloudflare: {
        fields: [
            { key: `apiToken`, source: `env`, envVar: `CLOUDFLARE_API_TOKEN` },
            // The zone picked at connect time; resolve validates domains against it instead of re-discovering
            // it from the token. Optional: an entry without it falls back to token-based discovery.
            { key: `zone`, source: `string`, optional: true },
        ],
    },
    github: {
        fields: [{ key: `token`, source: `env`, envVar: `GITHUB_TOKEN` }],
    },
    // GitLab is self-hostable, so an optional instance url is written when non-default; owner/registry are
    // advanced and authored by hand.
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

// i.want.service field specs (beyond kind/on/expose, which are rendered structurally). Every catalog
// service takes just a domain, ports/env are the provider's concern.
const SERVICE_REGISTRY: Record<ServiceKind, ProviderSpec> = {
    signoz: { fields: [{ key: `domain`, source: `string` }] },
    outline: { fields: [{ key: `domain`, source: `string` }] },
    paperless: { fields: [{ key: `domain`, source: `string` }] },
    openproject: { fields: [{ key: `domain`, source: `string` }] },
    invoiceninja: { fields: [{ key: `domain`, source: `string` }] },
    infisical: { fields: [{ key: `domain`, source: `string` }] },
};

// The env var a host's SSH private key rides. `self` keeps HOST_SSH_KEY (legacy); any other host `<name>` reads
// env("<NAME>_SSH_KEY") (name upper-cased). ONE rule, shared by the render below and the daemon's /enroll route
// (enroll-host.ts) so the two can never drift.
export const hostSshKeyVar = (name: string): string => (name === `self` ? `HOST_SSH_KEY` : `${name.toUpperCase()}_SSH_KEY`);

// Returns undefined for non-host / non-sshKey fields so they use their static envVar.
const hostSshKeyEnvVar = (entry: InventoryEntry, field: FieldSpec): string | undefined =>
    entry.kind === `backend` && entry.provider === `host` && field.key === `sshKey` ? hostSshKeyVar(entry.name) : undefined;

const renderOption = (entry: InventoryEntry, field: FieldSpec): string | undefined => {
    if (field.source === `env`) {
        return `${field.key}: env(${JSON.stringify(hostSshKeyEnvVar(entry, field) ?? field.envVar ?? ``)})`;
    }
    const value = entry.values[field.key];
    // An optional field with no value is omitted entirely rather than rendered as an empty literal.
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

// i.want.service references its host + cloudflare bindings by name (bare identifiers. NOT quoted), so the
// generated TS wires the same const bindings the backend entries declare.
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

// i.want.app wires on/expose like a service; the single production environment carries the domain, branch fixed
// to main. Kept to one line so the region's line-based parse stays lossless.
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

// Rewrites the managed region in `src` to exactly `entries`. Replaces the existing region when present; otherwise
// inserts one just inside the defineIntent callback body. Throws when neither is possible (no defineIntent found).
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

// Best-effort parse of the option object source into display values: `key: "string"` and `key: 123`. env(...)
// references (secrets) and bare-identifier references (on/expose) are intentionally skipped, not display values.
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

// Pick only the known display fields of a service kind out of the parsed values (drops `kind`, which the
// parser also captures as a string value).
const serviceValues = (kind: ServiceKind, all: Record<string, string | number>): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const field of SERVICE_REGISTRY[kind].fields) {
        if (field.key in all) {
            values[field.key] = all[field.key] as string | number;
        }
    }
    return values;
};

// Parses the i.have.* and i.want.service declarations inside the managed region into structured entries.
// Unknown providers/services (anything not in the registries) are skipped, the inventory only surfaces what
// the platform knows how to manage, so a hand-authored declaration we don't model is left untouched.
export const readManagedRegion = (src: string): InventoryEntry[] => {
    const lines = src.split(`\n`);
    const begin = lines.findIndex((line) => line.trim().startsWith(BEGIN_TAG));
    const end = lines.findIndex((line) => line.trim().startsWith(END_TAG));
    if (begin === -1 || end === -1 || end <= begin) {
        return [];
    }

    const entries: InventoryEntry[] = [];
    for (const line of lines.slice(begin + 1, end)) {
        // service: i.want.service("name", { kind, on, expose, ... }), on/expose are bare const references.
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
        // app: i.want.app("name", { on, expose, environments: { production: { domain, branch } } }).
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
        // backend: i.have.<provider>("name", { ... }).
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

// A fresh deploy.config.ts containing only the managed region, the base when writing inventory into a repo
// that has no config yet, and the neutral ledger the CLI's `init --minimal` and the daemon's first-boot scaffold.
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
