import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeSecretFile } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { LONG_OUTAGE_ATTEMPTS, type PeerLinkState, type PeerOutage } from "@intentic/sandbox-contract/peer-dial";
import { baseDir } from "../config.js";

// Device state lives at ~/.intentic/machine/device.json and audit.jsonl; permissions come from writeSecretFile.
export const configPath = join(baseDir, "device.json");
export const auditPath = join(baseDir, "audit.jsonl");

/* WHAT EACH LINK'S SOCKET IS DOING, stamped by the resident agent for the processes that are not it. */
export const linkStatePath = join(baseDir, "links.tick");

// How often the agent stamps, and the age past which a reader treats the stamp as no answer. Four ticks of
// slack, so a machine busy enough to miss one does not report its links as unknown.
export const LINK_STAMP_MS = 5_000;
export const LINK_STAMP_STALE_MS = LINK_STAMP_MS * 4;

// One link as the processes that are not the agent see it: what its socket is doing, and — only while something is
// wrong — how long it has been wrong for. `status` renders the first; the capability card counts the second.
export interface LinkReading {
    readonly state: PeerLinkState;
    readonly outage?: PeerOutage;
}

interface LinkStateStamp {
    readonly at: number;
    readonly links: Readonly<Record<string, LinkReading>>;
}

// Best-effort, like the sync half's heartbeat: a stamp that fails to write costs one `status` its live answer,
// and must never be able to take a connection down with it.
export const stampLinkStates = async (links: Readonly<Record<string, LinkReading>>): Promise<void> => {
    await writeFile(linkStatePath, JSON.stringify({ at: Date.now(), links } satisfies LinkStateStamp)).catch(() => undefined);
};

// A torn read is a writer mid-stamp, not a fault: unlike the config beside it, this file is rewritten every few
// seconds and the next reader gets a whole one.
const parseStamp = (raw: string | undefined): LinkStateStamp | undefined => {
    try {
        const parsed = raw === undefined ? undefined : (JSON.parse(raw) as Partial<LinkStateStamp>);
        return typeof parsed?.at === "number" && parsed.links !== undefined ? { at: parsed.at, links: parsed.links } : undefined;
    } catch {
        return undefined;
    }
};

// What the agent last stamped, or undefined when there is no usable answer: no file, unreadable, or too old to be
// about now. Callers report that absence as unknown rather than choosing a state to show.
export const readLinkStates = async (now = Date.now()): Promise<Readonly<Record<string, LinkReading>> | undefined> => {
    const stamped = parseStamp(await readFile(linkStatePath, "utf8").catch(() => undefined));
    return stamped === undefined || now - stamped.at > LINK_STAMP_STALE_MS ? undefined : stamped.links;
};

// Which links have been failing long enough to be treated as gone, at the same threshold the dial loop uses to stop
// reading silence as a restart — one line, drawn once, so the count the card shows and the set the drop removes can
// never disagree. Read from a stamp only: with no live reading there is no evidence, and the callers of this delete.
export const unreachableIn = (stamped: Readonly<Record<string, LinkReading>>): readonly { url: string; outage: PeerOutage }[] =>
    Object.entries(stamped).flatMap(([url, reading]) =>
        reading.outage !== undefined && reading.outage.failures >= LONG_OUTAGE_ATTEMPTS ? [{ url, outage: reading.outage }] : [],
    );

// One sandbox this device answers to. Scopes are a cache, not the source of truth: the sandbox pushes them on every
// connect; the token is the real credential, currently in a 0600 file rather than the OS keychain.
export interface HostLink {
    // Identity of the link: the key everything upserts and removes by, one sandbox per link.
    readonly sandboxUrl: string;
    // The capability id on the sandbox: this device's name and its tools' prefix there.
    readonly id: string;
    readonly token: string;
    readonly scopes: DeviceScopes;
}

// What setup writes and every command reads back: a list of links, so connecting a second sandbox doesn't overwrite the
// first.
export interface DeviceConfigFile {
    readonly links: readonly HostLink[];
    // Whether sandbox updates download in the background (auto-prepare.ts); absent means on.
    readonly prepareUpdates?: boolean;
}

// The config as written. A missing file is an EMPTY link list, not an error: "nothing has ever been connected here" is
// a real answer every caller has a use for. A file that EXISTS and won't parse is a genuine fault and propagates, the
// same rule the sync half's readState keeps — because the two callers that read "no links" act on it destructively:
// the agent retires its own login entry (resident.ts) and every writer below rebuilds the file from what it read.
export const readDeviceConfig = async (): Promise<DeviceConfigFile> => {
    const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    return raw === undefined ? { links: [] } : (JSON.parse(raw) as DeviceConfigFile);
};

export const writeDeviceConfig = async (config: DeviceConfigFile): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(config, undefined, 2));

// Read-modify-write for every writer below, so none of them rebuild the file from `links` alone and drop another field.
// Every mutation writes the whole file back, so what this reads decides what survives: content this build cannot PARSE
// is set aside and started over, and anything else (a lock, a permission, a disk) propagates untouched. Collapsing the
// two is what let one unreadable moment replace a machine's links with the absence of them — `rememberScopes` runs on
// every connect and writes whatever it read.
const updateDeviceConfig = async (mutate: (config: DeviceConfigFile) => DeviceConfigFile): Promise<DeviceConfigFile> => {
    const config = await readDeviceConfig().catch(async (error: unknown) => {
        if (!(error instanceof SyntaxError)) {
            throw error;
        }
        await rename(configPath, `${configPath}.corrupt`).catch(() => undefined);
        return { links: [] } satisfies DeviceConfigFile;
    });
    const next = mutate(config);
    await writeDeviceConfig(next);
    return next;
};

// Every link, or none when nothing has ever been connected, so a missing file and an empty list aren't two cases. An
// unreadable file is a third case and throws: callers act on emptiness, and none of them may act on a guess.
export const readLinks = async (): Promise<readonly HostLink[]> => (await readDeviceConfig()).links ?? [];

// Adds a sandbox, keeping the others; replaces rather than duplicates an existing one (a token rotation or
// re-enrollment). Keyed on the url, the link's one sandbox-chosen identity field.
export const upsertLink = async (link: HostLink): Promise<readonly HostLink[]> => {
    const updated = await updateDeviceConfig((config) => ({
        ...config,
        links: [...config.links.filter((existing) => existing.sandboxUrl !== link.sandboxUrl), link],
    }));
    return updated.links;
};

// Forget one sandbox, or all of them. Returns what was actually dropped so the caller can say so by name.
export const removeLinks = async (sandboxUrl?: string): Promise<readonly HostLink[]> => {
    const links = await readLinks();
    const dropped = sandboxUrl === undefined ? links : links.filter((link) => link.sandboxUrl === sandboxUrl);
    await updateDeviceConfig((config) => ({ ...config, links: config.links.filter((link) => !dropped.some((gone) => gone.sandboxUrl === link.sandboxUrl)) }));
    return dropped;
};

// Persists the scopes one sandbox just pushed, leaving other links alone. Best-effort: the live grant is already
// enforcing in memory, so a failed write must never drop the connection.
export const rememberScopes = async (sandboxUrl: string, scopes: DeviceScopes): Promise<void> => {
    await updateDeviceConfig((config) => {
        const at = config.links.findIndex((link) => link.sandboxUrl === sandboxUrl);
        // A push from a disconnected sandbox is dropped, not re-added, since its socket may just still be closing.
        const link = config.links[at];
        return link === undefined ? config : { ...config, links: config.links.with(at, { ...link, scopes }) };
    }).catch(() => undefined);
};

// The background-download switch; absent or unreadable reads as on. A preference, not a credential: the cost of
// guessing it is one download, so this is the one reader here that may.
export const readPrepareUpdates = async (): Promise<boolean> => (await readDeviceConfig().catch(() => undefined))?.prepareUpdates !== false;

export const writePrepareUpdates = async (on: boolean): Promise<void> => {
    await updateDeviceConfig((config) => ({ ...config, prepareUpdates: on }));
};
