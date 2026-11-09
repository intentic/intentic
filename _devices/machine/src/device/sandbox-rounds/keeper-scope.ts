import { execBounded } from "@intentic/base/process";
import { isRunner } from "./runner-keeper.js";

/* WHICH SANDBOXES THIS ENVIRONMENT KEEPS, as the keeper (keeper.ts) and the resident (resident.ts) read ic's listing,
   its records and its trash. Split from keeper.ts, which re-exports it. */

// A person's sandboxes, which `ic sandbox fix` and the idle sweep are for; runners have their own round (runner-keeper.ts).
const people = (slugs: readonly string[]): string[] => slugs.filter((slug) => !isRunner(slug));

// One row of `ic sandbox list --json` as far as the keeper reads it: which sandbox, and the other side of this computer
// that keeps it, when another does (`keptElsewhere`, absent for this side's own and from an older ic).
export interface ListedSandbox {
    readonly slug: string;
    // Its container's name, where the restart intent is written (restartIntent below); absent from a fake listing.
    readonly container?: string | undefined;
    readonly keptElsewhere?: string | undefined;
    // Put to sleep for want of use (sleep.ts): its link is down on purpose, and the keeper leaves it be.
    readonly asleep?: boolean | undefined;
    // Its container is running; absent from a fake listing.
    readonly running?: boolean | undefined;
}

/* WHOSE SANDBOXES THE KEEPER LOOKS AFTER (2026-10-05). On Windows, ic on Windows and ic in each WSL distro list every
   sandbox on the one Docker engine, but only the side that created a sandbox keeps it, and every environment runs a
   keeper. So each keeper sweeps only while its environment keeps a sandbox of its own: one the listing names without
   `keptElsewhere` (a sandbox the other side has stopped keeping is listed without it once ic adopts it, so adoption
   reaches this side by the same rule), or one this environment's ic still holds a record of that sits in ic's trash.
   And a slug with no container and no trash entry is gone: a dead link or a leftover record naming it is not a reason
   to run `ic sandbox fix` on it every few minutes for ever, which is what rog did for sandbox-2e8d89d75865. Absence
   proves nothing until Docker has answered, though: until a listing has, the records are all there is, and the logon
   case (Docker Desktop off after a reboot) is exactly when the keeper must still run. */
export interface KeeperScope {
    // The sandboxes this environment keeps, which are what a sweep is for; and those of them with a container, which are
    // what ic acts on and what a sweep holds up front (none while no listing has answered: ic names what it acts on).
    readonly own: readonly string[];
    readonly running: readonly string[];
    // Whether a slug still exists on this engine (a container, or an entry in ic's trash); always true while no listing
    // has answered, since nothing can be told then.
    readonly present: (slug: string) => boolean;
    // The listed sandboxes another side keeps: never this keeper's to fix.
    readonly elsewhere: ReadonlySet<string>;
}

// Pure over the last listing that answered (undefined while none has), this environment's records, and the slugs in
// ic's trash (undefined when they could not be read, which counts as none: on doubt, nothing is acted on).
export const keeperScope = (
    listed: readonly ListedSandbox[] | undefined,
    records: readonly string[],
    trashed: readonly string[] | undefined,
): KeeperScope => {
    // Until Docker answers, a runner's record counts too: the sweep's fix is what starts the engine after a reboot.
    if (listed === undefined) {
        return { own: [...records], running: [], present: () => true, elsewhere: new Set() };
    }
    const containers = new Set(listed.map((row) => row.slug));
    const binned = new Set(trashed ?? []);
    const mine = listed.filter((row) => row.keptElsewhere === undefined).map((row) => row.slug);
    const recordedInTrash = records.filter((slug) => !containers.has(slug) && binned.has(slug));
    return {
        own: people([...new Set([...mine, ...recordedInTrash])]),
        running: people(mine),
        present: (slug) => containers.has(slug) || binned.has(slug),
        elsewhere: new Set(listed.filter((row) => row.keptElsewhere !== undefined).map((row) => row.slug)),
    };
};

// The sandboxes this machine hosts and this environment keeps, for the resident's "is anything left to serve": the
// listing when Docker answers (it alone knows a removed sandbox is gone, and which side keeps the rest), else this
// environment's records, which are all there is while Docker is down.
export const hostedSlugs = async (listing: () => Promise<readonly ListedSandbox[]>, records: () => Promise<readonly string[]>): Promise<string[]> => {
    // allow(silent-catch): a listing that fails is Docker being down, which is exactly when the records answer instead
    const listed = await listing().catch(() => undefined);
    return listed === undefined ? [...(await records())] : listed.filter((row) => row.keptElsewhere === undefined).map((row) => row.slug);
};

// ic's trash on this engine, read off the marker volume each removal leaves (`intentic-trashed-<unix seconds>-<slug>`,
// ic: sandbox/trash.rs), which is the one place ic writes it down. Pure.
export const trashedFrom = (volumes: string): string[] =>
    volumes
        .split(/\r?\n/)
        .map((name) => /^intentic-trashed-\d+-(.+)$/.exec(name.trim())?.[1])
        .filter((slug): slug is string => slug !== undefined);

// Throws when docker does not answer: an unread trash is not an empty one.
export const readTrashed = async (): Promise<string[]> => {
    const { stdout } = await execBounded("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", "name=intentic-trashed-"], { timeoutMs: 20_000 });
    return trashedFrom(stdout);
};
