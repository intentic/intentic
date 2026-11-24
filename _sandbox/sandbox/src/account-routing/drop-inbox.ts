import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonOr } from "@intentic/base/json";
import { type ReceivedDrop, ReceivedDropSchema } from "@intentic/sandbox-contract/schemas/account-routes";

/* THE INBOX A DROP LANDS IN (2026-11-24, docs/architecture/account-routing.md): one folder per drop on the HISTORY volume,
 * `account-inbox/<id>/`, holding its manifest (`drop.json`: who sent it, as whom, the note, the files) and its files under
 * `files/`. Never the workspace: an agent there could write a manifest naming any sandbox and any person, and the inbox
 * would show it as theirs. Reached only through the daemon (inbox.routes.ts), which cuts it to the people a drop names. */

// Bounded like the outbox: a sender looping on drops fills a list, never the disk.
const INBOX_MAX = 200;
const MANIFEST = "drop.json";
const FILES = "files";
// The id of a drop here: the sender's tunnel id and its own id for the drop, so a retry of one drop lands once.
const ID = /^[0-9a-f]{12}-[A-Za-z0-9_-]{8,80}$/u;

export const inboxIdOf = (from: string, dropId: string): string => `${from}-${dropId}`;

interface DropInbox {
    readonly list: () => Promise<readonly ReceivedDrop[]>;
    readonly get: (id: string) => Promise<ReceivedDrop | undefined>;
    // The files whole, by name, for a drop there is.
    readonly files: (id: string) => Promise<ReadonlyArray<{ readonly name: string; readonly bytes: Buffer }> | undefined>;
    // Files the drop and its manifest; answers false when the inbox is full.
    readonly receive: (drop: ReceivedDrop, files: ReadonlyArray<{ readonly name: string; readonly bytes: Buffer }>) => Promise<boolean>;
    readonly remove: (id: string) => Promise<boolean>;
}

export const fileDropInbox = (historyRoot: string): DropInbox => {
    // Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
    const root = join(historyRoot, "account-inbox");
    const dirOf = (id: string): string | undefined => (ID.test(id) ? join(root, id) : undefined);

    const get = async (id: string): Promise<ReceivedDrop | undefined> => {
        const dir = dirOf(id);
        if (dir === undefined) {
            return undefined;
        }
        // allow(silent-catch): a drop that is not there (or half-written by a crash) reads as none.
        const text = await readFile(join(dir, MANIFEST), "utf8").catch(() => undefined);
        const parsed = ReceivedDropSchema.safeParse(text === undefined ? undefined : parseJsonOr(text, undefined));
        return parsed.success && parsed.data.id === id ? parsed.data : undefined;
    };

    const ids = async (): Promise<string[]> => {
        // allow(silent-catch): no inbox yet is an empty one.
        const names: readonly string[] = await readdir(root).catch(() => []);
        return names.filter((name) => ID.test(name));
    };

    return {
        get,
        list: async () => {
            const drops = await Promise.all((await ids()).map(get));
            return drops.filter((drop): drop is ReceivedDrop => drop !== undefined).sort((a, b) => b.receivedAt - a.receivedAt);
        },
        files: async (id) => {
            const drop = await get(id);
            const dir = dirOf(id);
            if (drop === undefined || dir === undefined) {
                return undefined;
            }
            return Promise.all(drop.files.map(async (file) => ({ name: file.name, bytes: await readFile(join(dir, FILES, file.name)) })));
        },
        receive: async (drop, files) => {
            const dir = dirOf(drop.id);
            if (dir === undefined) {
                throw new Error(`not an inbox id: ${drop.id}`);
            }
            if ((await ids()).length >= INBOX_MAX) {
                return false;
            }
            // Written aside and renamed into place, so a crash leaves no half a drop that lists.
            const partial = join(root, `.partial-${drop.id}`);
            await rm(partial, { recursive: true, force: true });
            await mkdir(join(partial, FILES), { recursive: true });
            for (const file of files) {
                await writeFile(join(partial, FILES, file.name), file.bytes);
            }
            await writeFile(join(partial, MANIFEST), `${JSON.stringify(drop, null, 2)}\n`);
            await rm(dir, { recursive: true, force: true });
            await rename(partial, dir);
            return true;
        },
        remove: async (id) => {
            const dir = dirOf(id);
            if (dir === undefined || (await get(id)) === undefined) {
                return false;
            }
            await rm(dir, { recursive: true, force: true });
            return true;
        },
    };
};
