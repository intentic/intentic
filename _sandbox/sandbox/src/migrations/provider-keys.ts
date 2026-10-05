import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import {
    type Capability,
    CapabilitySchema,
    type EndpointProtocol,
    type ProviderKey,
    type ProviderKeySource,
    type ProviderKeysApplied,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { capabilityCtx } from "../capabilities/capability.js";
import { capabilitiesDocument } from "../capabilities/capabilities-store.js";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { composeEnvironment } from "../environment/environment.js";
import type { HostHub } from "../hosts/host-peer.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { entryId } from "./adapter-shared.js";
import { hostCapabilities } from "./assistants.js";
import { hermesAuthKeys } from "./hermes.js";
import { callTool, listDir, separatorOf } from "./host-scan.js";
import { AUTH_PROFILES_PATH, openclawProfileKeys } from "./openclaw.js";

// The model API keys already on the owner's computer, offered as model endpoints. Reads a short, fixed list of files
// off a connected device (no walk), and takes only plain API keys out of them: an OAuth login is bound to the install
// holding it, and its refresh token is single-use, so a copy signs out whichever side refreshes second (scan-policy.ts).
// A missing or unreadable file is an ordinary "nothing here". The key's value stays in the daemon: the browser is shown
// a digest and four characters, and an add reads the device again rather than taking a value back from it.

// One model API this sandbox knows how to reach with nothing but a key. No such table existed: the endpoint tile takes
// any URL and suggests none. Each base is the vendor's own documented one, and each serves `GET <base>/models` in the
// shape the endpoint catalog reads, which is what makes a key here a provider in the picker. A provider missing from
// this list is reported and not offered.
interface KeyProvider {
    readonly id: string;
    readonly label: string;
    // Other names the source tools file the same provider under (opencode's models.dev ids, OpenClaw's profiles).
    readonly aliases: readonly string[];
    // The environment names a `.env` holds its key under.
    readonly env: readonly string[];
    readonly baseUrl: string;
    readonly protocol: EndpointProtocol;
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
    { id: "anthropic", label: "Anthropic", aliases: [], env: ["ANTHROPIC_API_KEY"], baseUrl: "https://api.anthropic.com", protocol: "anthropic" },
    { id: "openai", label: "OpenAI", aliases: [], env: ["OPENAI_API_KEY"], baseUrl: "https://api.openai.com/v1", protocol: "openai" },
    { id: "openrouter", label: "OpenRouter", aliases: [], env: ["OPENROUTER_API_KEY"], baseUrl: "https://openrouter.ai/api/v1", protocol: "openai" },
    {
        id: "gemini",
        label: "Gemini",
        aliases: ["google", "google-gemini"],
        env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        // The platform's free trial reads the same surface (_platform/api config.ts `trial.baseUrl`).
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        protocol: "openai",
    },
    { id: "xai", label: "xAI", aliases: ["grok", "x-ai"], env: ["XAI_API_KEY", "GROK_API_KEY"], baseUrl: "https://api.x.ai/v1", protocol: "openai" },
    { id: "deepseek", label: "DeepSeek", aliases: [], env: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
    { id: "groq", label: "Groq", aliases: [], env: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1", protocol: "openai" },
    { id: "mistral", label: "Mistral", aliases: [], env: ["MISTRAL_API_KEY"], baseUrl: "https://api.mistral.ai/v1", protocol: "openai" },
    { id: "moonshot", label: "Moonshot", aliases: ["moonshotai"], env: ["MOONSHOT_API_KEY"], baseUrl: "https://api.moonshot.ai/v1", protocol: "openai" },
];

const providerNamed = (name: string): KeyProvider | undefined => {
    const wanted = name.trim().toLowerCase();
    return KEY_PROVIDERS.find((provider) => provider.id === wanted || provider.aliases.includes(wanted));
};

// The files read, relative to the home folder and forward-slashed. OpenClaw's are one per agent, found by listing.
export const KEY_FILES = {
    hermesEnv: ".hermes/.env",
    hermesAuth: ".hermes/auth.json",
    opencode: ".local/share/opencode/auth.json",
    geminiEnv: ".gemini/.env",
    codex: ".codex/auth.json",
} as const;
const OPENCLAW_DIR = ".openclaw";
const OPENCLAW_AGENTS = `${OPENCLAW_DIR}/agents`;
// Each agent's profiles file is one more round trip; a home with more agents than this is read for its first ones.
const MAX_OPENCLAW_AGENTS = 16;

// One key as read: the provider it is for, in the source's own words, and the tool whose file held it.
export interface FoundKey {
    readonly provider: string;
    readonly source: ProviderKeySource;
    readonly key: string;
}

// A value that is a key rather than a pointer to one (`${VAR}`) or a redacted stand-in: long enough to be a credential
// and one unbroken token.
const keyValue = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length < 12 || /\s/.test(trimmed) || /^\$\{[^}]+\}$/.test(trimmed) ? undefined : trimmed;
};

// A file's text, already read off the device, as JSON into `schema`; undefined for text that is not JSON, or JSON of
// another shape. Opens nothing: the device's own read did.
const parsedJson = <Schema extends z.ZodType>(schema: Schema, raw: string | undefined): z.infer<Schema> | undefined => {
    if (raw === undefined) {
        return undefined;
    }
    try {
        return schema.safeParse(JSON.parse(raw)).data;
    } catch {
        // allow(silent-catch): a file that is not JSON holds no key, which is the answer.
        return undefined;
    }
};

// A `.env` as node reads one: every value a string.
const EnvSchema = z.record(z.string(), z.string());

// Only the names that say which provider they are for: a tool's `.env` also holds search, voice and bot tokens that are
// no model's key.
const envKeys = (raw: string | undefined, source: ProviderKeySource): FoundKey[] => {
    const env = raw === undefined ? undefined : EnvSchema.safeParse(parseEnv(raw)).data;
    return KEY_PROVIDERS.flatMap((provider) =>
        provider.env.flatMap((name) => {
            const key = keyValue(env?.[name]);
            return key === undefined ? [] : [{ provider: provider.id, source, key }];
        }),
    );
};

// opencode's auth.json: one entry per provider id, `{type: "api", key}` for a pasted key; `oauth` and `wellknown` entries
// are logins, and fail this schema.
const OpencodeAuthSchema = z.record(z.string(), z.unknown());
const OpencodeKeySchema = z.object({ type: z.literal("api"), key: z.string() });
const opencodeKeys = (raw: string | undefined): FoundKey[] =>
    Object.entries(parsedJson(OpencodeAuthSchema, raw) ?? {}).flatMap(([provider, entry]) => {
        const key = keyValue(OpencodeKeySchema.safeParse(entry).data?.key);
        return key === undefined ? [] : [{ provider, source: "opencode" as const, key }];
    });

// Codex's auth.json holds an API key only when the CLI was logged in with one; `tokens` beside it is the ChatGPT login.
const CodexAuthSchema = z.object({ OPENAI_API_KEY: z.string().nullish() });
const codexKeys = (raw: string | undefined): FoundKey[] => {
    const key = keyValue(parsedJson(CodexAuthSchema, raw)?.OPENAI_API_KEY ?? undefined);
    return key === undefined ? [] : [{ provider: "openai", source: "codex", key }];
};

/**
 * Every key in a home folder's files, keyed by their path relative to it, in source order (ProviderKeySourceSchema):
 * the order a key held by more than one tool is attributed in. Pure, so the device read and its tests share it.
 */
export const keysInFiles = (files: ReadonlyMap<string, string>): FoundKey[] => {
    const hermesAuth = files.get(KEY_FILES.hermesAuth);
    const openclaw = [...files.entries()]
        .filter(([path]) => path.startsWith(`${OPENCLAW_DIR}/`) && AUTH_PROFILES_PATH.test(path.slice(OPENCLAW_DIR.length + 1)))
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([, raw]) => openclawProfileKeys(raw)?.keys ?? []);
    return [
        ...envKeys(files.get(KEY_FILES.hermesEnv), "hermes"),
        ...(hermesAuth === undefined ? [] : (hermesAuthKeys(hermesAuth)?.keys ?? [])).flatMap((entry) => {
            const key = keyValue(entry.key);
            return key === undefined ? [] : [{ provider: entry.provider, source: "hermes" as const, key }];
        }),
        ...openclaw.flatMap((entry) => {
            const key = keyValue(entry.key);
            return key === undefined ? [] : [{ provider: entry.provider, source: "openclaw" as const, key }];
        }),
        ...opencodeKeys(files.get(KEY_FILES.opencode)),
        ...envKeys(files.get(KEY_FILES.geminiEnv), "gemini"),
        ...codexKeys(files.get(KEY_FILES.codex)),
    ];
};

// The row's id: a digest of the key, so the browser can name it without ever holding it.
export const keyId = (key: string): string => `key-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

// The endpoint a found key becomes, or undefined for a provider this sandbox does not know how to reach.
export const endpointOf = (found: FoundKey): { readonly baseUrl: string; readonly protocol: EndpointProtocol; readonly apiKey: string } | undefined => {
    const provider = providerNamed(found.provider);
    return provider === undefined ? undefined : { baseUrl: provider.baseUrl, protocol: provider.protocol, apiKey: found.key };
};

// The keys an endpoint here already holds.
const heldKeys = (capabilities: readonly Capability[]): Set<string> =>
    new Set(capabilities.flatMap((capability) => (capability.kind === "endpoint" && capability.config.apiKey !== undefined ? [capability.config.apiKey] : [])));

/** One row per distinct key across every device, the first device and source to hold it named. */
export const keyRows = (found: readonly { readonly host: string; readonly key: FoundKey }[], capabilities: readonly Capability[]): ProviderKey[] => {
    const held = heldKeys(capabilities);
    const seen = new Set<string>();
    return found.flatMap(({ host, key: entry }) => {
        if (seen.has(entry.key)) {
            return [];
        }
        seen.add(entry.key);
        const provider = providerNamed(entry.provider);
        return [
            {
                id: keyId(entry.key),
                provider: provider?.id ?? entry.provider,
                label: provider?.label ?? entry.provider,
                source: entry.source,
                host,
                hint: entry.key.slice(-4),
                applicable: provider !== undefined,
                added: held.has(entry.key),
            },
        ];
    });
};

// A capability id for a new endpoint: the provider's own name, numbered past the ids already taken.
export const endpointId = (provider: string, taken: ReadonlySet<string>): string => {
    const base = entryId(provider);
    for (let suffix = 1; ; suffix += 1) {
        const id = suffix === 1 ? base : `${base.slice(0, 56)}-${suffix}`;
        if (!taken.has(id)) {
            return id;
        }
    }
};

// ---- the device read ----

// A connected device as this module reads it: its capability id and its home folder.
export interface KeyDevice {
    readonly id: string;
    readonly home: string;
}

/** Reads the fixed files off one device, keyed by path relative to its home; whatever does not answer is left out. */
export const readKeyFiles = async (hub: Pick<HostHub, "mcp">, device: KeyDevice): Promise<Map<string, string>> => {
    const separator = separatorOf(device.home);
    const absolute = (rel: string): string => `${device.home}${separator}${rel.split("/").join(separator)}`;
    let seq = 0;
    const next = (): number => {
        seq += 1;
        return seq;
    };
    // allow(silent-catch): no agents folder (no OpenClaw here, or a refusal) is no profiles to read.
    const agents = await listDir(hub, device.id, absolute(OPENCLAW_AGENTS), next()).catch(() => []);
    const paths = [
        ...Object.values(KEY_FILES),
        ...agents
            .filter((entry) => entry.kind === "directory")
            .slice(0, MAX_OPENCLAW_AGENTS)
            .map((entry) => `${OPENCLAW_AGENTS}/${entry.name}/agent/auth-profiles.json`),
    ];
    const read = await Promise.all(
        paths.map(async (rel) => {
            // allow(silent-catch): a missing or unreadable file is an ordinary "nothing here", the device's own words unneeded.
            const text = await callTool(hub, device.id, "read_file", { path: absolute(rel) }, next()).catch(() => undefined);
            return text === undefined ? [] : [[rel, text] as const];
        }),
    );
    return new Map(read.flat());
};

// What the two calls need of the daemon, apart so they can be driven without one.
export interface ProviderKeyDeps {
    readonly hub: Pick<HostHub, "mcp">;
    // The owner's devices that are online and have said where their home folder is.
    readonly devices: () => Promise<readonly KeyDevice[]>;
    readonly capabilities: () => Promise<readonly Capability[]>;
    // Applies and stores one new endpoint, the capability route's own sequence.
    readonly addEndpoint: (capability: Capability) => Promise<void>;
    // What the capability route runs after a write, once after every add.
    readonly settle: () => Promise<void>;
}

const foundOnDevices = async (deps: ProviderKeyDeps): Promise<{ readonly host: string; readonly key: FoundKey }[]> => {
    const devices = await deps.devices();
    const perDevice = await Promise.all(
        devices.map(async (device) => keysInFiles(await readKeyFiles(deps.hub, device)).map((key) => ({ host: device.id, key }))),
    );
    return perDevice.flat();
};

/** GET /arrivals/keys: every model key on the owner's connected devices. No device is an empty list. */
export const listProviderKeys = async (deps: ProviderKeyDeps): Promise<ProviderKey[]> => {
    const [found, capabilities] = await Promise.all([foundOnDevices(deps), deps.capabilities()]);
    return keyRows(found, capabilities);
};

/** POST /arrivals/keys/apply: each named row becomes a model endpoint, read off the device again. */
export const applyProviderKeys = async (deps: ProviderKeyDeps, ids: readonly string[]): Promise<ProviderKeysApplied> => {
    const [found, capabilities] = await Promise.all([foundOnDevices(deps), deps.capabilities()]);
    const byId = new Map<string, FoundKey>();
    for (const { key } of found) {
        if (!byId.has(keyId(key.key))) {
            byId.set(keyId(key.key), key);
        }
    }
    const taken = new Set(capabilities.map((capability) => capability.id));
    const holding = new Map(
        capabilities.flatMap((capability) =>
            capability.kind === "endpoint" && capability.config.apiKey !== undefined ? [[capability.config.apiKey, capability.id] as const] : [],
        ),
    );
    const added: ProviderKeysApplied["added"] = [];
    const failed: ProviderKeysApplied["failed"] = [];
    let wrote = false;
    for (const id of new Set(ids)) {
        const key = byId.get(id);
        if (key === undefined) {
            failed.push({ id, error: "that key is no longer on a connected device" });
            continue;
        }
        const existing = holding.get(key.key);
        if (existing !== undefined) {
            added.push({ id, capability: existing });
            continue;
        }
        const endpoint = endpointOf(key);
        if (endpoint === undefined) {
            failed.push({ id, error: `this sandbox does not know where ${key.provider} serves models; add it as a model endpoint by hand` });
            continue;
        }
        const capability = CapabilitySchema.parse({ id: endpointId(providerNamed(key.provider)?.id ?? key.provider, taken), kind: "endpoint", config: endpoint });
        try {
            await deps.addEndpoint(capability);
            taken.add(capability.id);
            holding.set(key.key, capability.id);
            added.push({ id, capability: capability.id });
            wrote = true;
        } catch (error) {
            failed.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    if (wrote) {
        await deps.settle();
    }
    return { added, failed };
};

/** The deps over the daemon's own services: its devices, its manifest, and the capability route's write sequence. */
export const providerKeyDeps = (services: Services): ProviderKeyDeps => {
    const ctx = capabilityCtx(services);
    return {
        hub: services.hostHub,
        devices: async () =>
            (await hostCapabilities(services)).flatMap((capability) => {
                const home = services.hostHub.online(capability.id) ? services.hostHub.state(capability.id).facts?.home : undefined;
                return home === undefined ? [] : [{ id: capability.id, home }];
            }),
        capabilities: () => services.capabilities.list(),
        // The capability route's own order: the handler's apply first (it probes the catalog), then the manifest entry,
        // committed as the page's own write is.
        addEndpoint: async (capability) => {
            for await (const line of registry[capability.kind].apply(ctx, capability.id, capability.config)) {
                void line;
            }
            await versionedSettingsWrite(services, [capabilitiesDocument.path], `Settings: connection ${capability.id}`, () =>
                services.capabilities.upsert(capability),
            );
        },
        // Awaited, as the route awaits it: "added" has to mean the next turn on the endpoint routes.
        settle: async () => {
            await syncEndpointCompat(services);
            await composeEnvironment(services);
        },
    };
};
