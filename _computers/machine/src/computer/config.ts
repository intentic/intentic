import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeSecretFile } from "@intentic/local-agent";
import type { HostScopes } from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";

// Everything the computer half persists lives in the agent's shared home (~/.intentic/machine, ../config.ts):
// the sandboxes it is enrolled with, their enrollment tokens and last-pushed scopes in a file of its OWN beside
// the sync half's (see the shared config for why the two never share one), and the audit log of everything the
// agent did here. The 0600 floor on what lands in it belongs to @intentic/local-agent, every agent on a user's
// machine keeps a credential in the same shape, and the one that kept its own copy of this wrote it
// world-readable.
export const configPath = join(baseDir, "computer.json");
export const auditPath = join(baseDir, "audit.jsonl");

/* ONE SANDBOX THIS COMPUTER ANSWERS TO. There are as many of these as the owner has connected.
 *
 * The scopes are a CACHE, not the source of truth. The sandbox pushes them on every connect, so what is written
 * here only decides how the agent behaves in the seconds before the first push (and if it is ever started while
 * offline). They are stored at all so that a refusal reads the same before and after a reconnect, an agent that
 * allowed everything until the first scopes frame would have a window where the grant was whatever the last
 * install defaulted to. They are PER LINK for the same reason they exist at all: two sandboxes are two
 * different grants, and one of them being allowed to run commands here says nothing about the other.
 *
 * The token is the one real credential. It sits in a 0600 file rather than the OS keychain today; the keychain
 * is the right home for it and is worth doing before this ships widely (Windows DPAPI / libsecret), because a
 * file readable by every process running as this user is a weaker boundary than the grant it protects. */
export interface HostLink {
    // Identity of the link, and the key everything below upserts and removes by: one sandbox, one link.
    readonly sandboxUrl: string;
    // The capability id on the sandbox, this computer's name, and the prefix of its tools over there.
    readonly id: string;
    readonly token: string;
    readonly scopes: HostScopes;
}

/* WHAT `intentic-machine computer setup` WRITES AND EVERY OTHER COMMAND READS BACK — a LIST, and that is the whole of this
 * change.
 *
 * It used to be one link, flat, and `setup` wrote it wholesale. So connecting a computer to a second sandbox
 * silently disconnected it from the first, and the flow that does that is not a command anybody types: it is
 * the LAST STEP OF ONBOARDING. Setting up a new sandbox on a computer that already had one took the computer
 * away from the old one — no prompt, no mention on the progress screen, and the replacement arrived with every
 * scope off, so for a while the machine answered to nobody. A person with a work sandbox and a personal one
 * cannot have both, and would discover that by losing one.
 *
 * A computer is a computer. Which sandboxes may drive it is a list, held here, and each entry carries its own
 * grant. */
export interface HostConfigFile {
    readonly links: readonly HostLink[];
    /* Whether this machine keeps its sandboxes' next update downloaded in the background (auto-prepare.ts),
     * so applying one is a half-minute restart instead of a wait of minutes. Absent means ON: the download
     * touches no container and `ic sandbox prepare` already declines on low disk, so the default costs
     * nothing worth asking about — and a setting that had to be discovered to start working would leave the
     * update card quoting minutes on every machine whose owner never found it. */
    readonly prepareUpdates?: boolean;
}

export const readHostConfig = async (): Promise<HostConfigFile> => JSON.parse(await readFile(configPath, "utf8")) as HostConfigFile;

export const writeHostConfig = async (config: HostConfigFile): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(config, undefined, 2));

// Read-modify-write for every writer below: each of them used to rebuild the file from `links` alone, which
// was correct while links were the whole file and silently drops every OTHER field the moment there is one.
const updateHostConfig = async (mutate: (config: HostConfigFile) => HostConfigFile): Promise<HostConfigFile> => {
    const config = (await readHostConfig().catch(() => undefined)) ?? { links: [] };
    const next = mutate(config);
    await writeHostConfig(next);
    return next;
};

// Every link, or none at all when nothing has ever been connected — the shape callers actually want, so that
// "this computer is connected to nothing" and "there is no config file" stop being two cases at every call site.
export const readLinks = async (): Promise<readonly HostLink[]> => (await readHostConfig().catch(() => undefined))?.links ?? [];

/* ADD A SANDBOX, KEEPING THE ONES ALREADY THERE — and replace rather than duplicate when it is one we already
 * answer to, because re-running setup against the same sandbox is how a token is rotated and how a revoked
 * computer is re-enrolled. Keyed on the url, which is the one field of a link that is the sandbox's identity
 * rather than something either side chose. */
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

// Persist the scopes one sandbox just pushed, leaving every other link alone. Best-effort by design: the live
// grant is already in memory and enforcing, so failing to write the cache must never drop the connection.
export const rememberScopes = async (sandboxUrl: string, scopes: HostScopes): Promise<void> => {
    await updateHostConfig((config) => {
        const at = config.links.findIndex((link) => link.sandboxUrl === sandboxUrl);
        // A push from a sandbox this computer does not answer to is dropped rather than written: it can only
        // be a link that was disconnected while its socket was still closing, and re-adding it would undo that.
        const link = config.links[at];
        return link === undefined ? config : { ...config, links: config.links.with(at, { ...link, scopes }) };
    }).catch(() => undefined);
};

// The background-download switch, read where the resident loop starts its tick and written by the `updates`
// command. Absent (or an unreadable file) reads as ON — see the field's note above.
export const readPrepareUpdates = async (): Promise<boolean> => (await readHostConfig().catch(() => undefined))?.prepareUpdates !== false;

export const writePrepareUpdates = async (on: boolean): Promise<void> => {
    await updateHostConfig((config) => ({ ...config, prepareUpdates: on }));
};
