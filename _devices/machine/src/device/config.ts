import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeSecretFile } from "@intentic/local-agent";
import type { HostScopes } from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";

// Device state lives at ~/.intentic/machine/device.json and audit.jsonl; permissions come from writeSecretFile.
export const configPath = join(baseDir, "device.json");
export const auditPath = join(baseDir, "audit.jsonl");

// One sandbox this device answers to. Scopes are a cache, not the source of truth: the sandbox pushes them on every
// connect; the token is the real credential, currently in a 0600 file rather than the OS keychain.
export interface HostLink {
    // Identity of the link: the key everything upserts and removes by, one sandbox per link.
    readonly sandboxUrl: string;
    // The capability id on the sandbox: this device's name and its tools' prefix there.
    readonly id: string;
    readonly token: string;
    readonly scopes: HostScopes;
}

// What setup writes and every command reads back: a list of links, so connecting a second sandbox doesn't overwrite the
// first.
export interface HostConfigFile {
    readonly links: readonly HostLink[];
    // Whether sandbox updates download in the background (auto-prepare.ts); absent means on.
    readonly prepareUpdates?: boolean;
}

export const readHostConfig = async (): Promise<HostConfigFile> => JSON.parse(await readFile(configPath, "utf8")) as HostConfigFile;

export const writeHostConfig = async (config: HostConfigFile): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(config, undefined, 2));

// Read-modify-write for every writer below, so none of them rebuild the file from `links` alone and drop another field.
const updateHostConfig = async (mutate: (config: HostConfigFile) => HostConfigFile): Promise<HostConfigFile> => {
    const config = (await readHostConfig().catch(() => undefined)) ?? { links: [] };
    const next = mutate(config);
    await writeHostConfig(next);
    return next;
};

// Every link, or none when nothing has ever been connected, so a missing file and an empty list aren't two cases.
export const readLinks = async (): Promise<readonly HostLink[]> => (await readHostConfig().catch(() => undefined))?.links ?? [];

// Adds a sandbox, keeping the others; replaces rather than duplicates an existing one (a token rotation or
// re-enrollment). Keyed on the url, the link's one sandbox-chosen identity field.
export const upsertLink = async (link: HostLink): Promise<readonly HostLink[]> => {
    const updated = await updateHostConfig((config) => ({
        ...config,
        links: [...config.links.filter((existing) => existing.sandboxUrl !== link.sandboxUrl), link],
    }));
    return updated.links;
};

// Forget one sandbox, or all of them. Returns what was actually dropped so the caller can say so by name.
export const removeLinks = async (sandboxUrl?: string): Promise<readonly HostLink[]> => {
    const links = await readLinks();
    const dropped = sandboxUrl === undefined ? links : links.filter((link) => link.sandboxUrl === sandboxUrl);
    await updateHostConfig((config) => ({ ...config, links: config.links.filter((link) => !dropped.some((gone) => gone.sandboxUrl === link.sandboxUrl)) }));
    return dropped;
};

// Persists the scopes one sandbox just pushed, leaving other links alone. Best-effort: the live grant is already
// enforcing in memory, so a failed write must never drop the connection.
export const rememberScopes = async (sandboxUrl: string, scopes: HostScopes): Promise<void> => {
    await updateHostConfig((config) => {
        const at = config.links.findIndex((link) => link.sandboxUrl === sandboxUrl);
        // A push from a disconnected sandbox is dropped, not re-added, since its socket may just still be closing.
        const link = config.links[at];
        return link === undefined ? config : { ...config, links: config.links.with(at, { ...link, scopes }) };
    }).catch(() => undefined);
};

// The background-download switch; absent or unreadable reads as on.
export const readPrepareUpdates = async (): Promise<boolean> => (await readHostConfig().catch(() => undefined))?.prepareUpdates !== false;

export const writePrepareUpdates = async (on: boolean): Promise<void> => {
    await updateHostConfig((config) => ({ ...config, prepareUpdates: on }));
};
