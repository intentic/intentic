import { accountPartition } from "@intentic/ui/storage";

// THE ACCOUNT'S INDEXEDDB DATABASES: one per account and purpose, `<base>.<account>`, the way its storage keys sit in
// its own drawer (@intentic/ui/storage). `<base>` alone is the database from before accounts had drawers, or of a page
// nobody's drawer is open in; it goes with the next account that is cleared, since it was whoever's was signed in then.

/** The database this page keeps `base` in: the open account's. */
export const accountDatabase = (base: string, account: string | undefined = accountPartition()): string =>
    account === undefined ? base : `${base}.${account}`;

const deleteDatabase = (name: string): Promise<void> =>
    new Promise((resolve) => {
        try {
            const request = globalThis.indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.addEventListener(`error`, () => resolve());
            // Another tab holds it open past its version-change handler: it is deleted once that tab lets go.
            request.onblocked = () => resolve();
        } catch {
            // Unavailable (private mode, disabled storage), then nothing was mirrored.
            resolve();
        }
    });

// Every account's database of `base` this browser can list, else the one name every build has used.
const everyDatabase = async (base: string): Promise<readonly string[]> => {
    try {
        const listed = await globalThis.indexedDB.databases();
        const names = listed.flatMap((database) => {
            const name = database.name;
            return name !== undefined && (name === base || name.startsWith(`${base}.`)) ? [name] : [];
        });
        return [...new Set([base, ...names])];
    } catch {
        // allow(silent-catch): a browser that cannot list its databases still deletes the one every build has used.
        return [base];
    }
};

/** Deletes one account's database of `base` (and the undrawered one), or every account's when none is named. */
export const deleteAccountDatabases = async (base: string, account: string | undefined): Promise<void> => {
    const names = account === undefined ? await everyDatabase(base) : [accountDatabase(base, account), base];
    await Promise.all(names.map(deleteDatabase));
};
