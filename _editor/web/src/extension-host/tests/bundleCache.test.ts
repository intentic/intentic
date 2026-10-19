import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import {
    type BundleEntries,
    type BundleStorage,
    bundleKeyOf,
    bundleModule,
    bundlePass,
    EXTENSION_BUNDLE_CACHE,
    exactRevisionOf,
    type Linked,
    type ServedSummary,
} from "../bundleCache";

// The loader's bundle cache (bundleCache.ts): a bundle is kept only under a revision that names its bytes exactly, kept
// per sandbox and extension, and a copy that is not what its key says is never what runs.

const COMMIT = `0123456789abcdef0123456789abcdef01234567`;
const OTHER_COMMIT = `89abcdef0123456789abcdef0123456789abcdef`;

// The daemon's fingerprint of a served bundle (extension-dev.ts bundleRevisionOf): sha256 over its bytes, 12 hex digits.
const fingerprint = (source: string): string => createHash(`sha256`).update(source).digest(`hex`).slice(0, 12);

const pinned = (overrides: Partial<ServedSummary> = {}): ServedSummary => ({
    id: `maintenance`,
    source: `installed`,
    commit: COMMIT,
    manifest: { entry: `dist/extension.js` },
    ...overrides,
});

const fromCheckout = (source: string, overrides: Partial<ServedSummary> = {}): ServedSummary =>
    pinned({ dev: { path: `extensions/maintenance`, revision: fingerprint(source) }, ...overrides });

// Cache Storage as far as the cache uses it: one named cache of URL-keyed responses.
const fakeStorage = () => {
    const entries = new Map<string, Response>();
    const opened: string[] = [];
    const urlOf = (key: string | Request): string => (key instanceof Request ? key.url : new URL(key).href);
    const cache: BundleEntries = {
        match: async (key) => entries.get(urlOf(key))?.clone(),
        put: async (key, response) => void entries.set(urlOf(key), response),
        delete: async (key) => entries.delete(urlOf(key)),
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
    };
    const storage: BundleStorage = {
        open: async (name) => {
            opened.push(name);
            return cache;
        },
    };
    return { entries, storage, opened };
};

const sourceIn = async (entries: Map<string, Response>, key: string): Promise<string | undefined> => entries.get(key)?.clone().text();

describe(`which revisions name a bundle exactly`, () => {
    test(`a git install on its pinned clone is its full commit`, () => {
        expect(exactRevisionOf(pinned())).toEqual({ kind: `commit`, value: COMMIT });
    });

    test(`a held dev pointer still serves the pinned clone, so it is the commit, whatever else the row carries`, () => {
        expect(exactRevisionOf(pinned({ dev: { path: `extensions/maintenance`, held: `it is not built yet` } }))).toEqual({ kind: `commit`, value: COMMIT });
        expect(exactRevisionOf(pinned({ dev: { path: `x`, held: `gone`, revision: `0123456789ab` } }))).toEqual({ kind: `commit`, value: COMMIT });
    });

    test(`a source checkout that runs is the fingerprint of its build`, () => {
        expect(exactRevisionOf(fromCheckout(`export const activate = () => {};`))).toEqual({
            kind: `dev`,
            value: fingerprint(`export const activate = () => {};`),
        });
    });

    test(`anything else is never cached`, () => {
        // A checkout that runs but has no fingerprint: the daemon hashes what it serves, the row names nothing.
        expect(exactRevisionOf(pinned({ dev: { path: `extensions/maintenance` } }))).toBeUndefined();
        // Built-in and workspace rows carry their source's name where a commit would be; a workspace folder is edited live.
        expect(exactRevisionOf(pinned({ source: `workspace`, commit: `workspace` }))).toBeUndefined();
        expect(exactRevisionOf(pinned({ source: `workspace`, commit: COMMIT }))).toBeUndefined();
        expect(exactRevisionOf(pinned({ source: `builtin`, commit: `builtin` }))).toBeUndefined();
        // An abbreviated or malformed commit, or a fingerprint of another shape, names no one bundle.
        expect(exactRevisionOf(pinned({ commit: `0123456` }))).toBeUndefined();
        expect(exactRevisionOf(pinned({ commit: `` }))).toBeUndefined();
        expect(exactRevisionOf(pinned({ dev: { path: `x`, revision: `0123` } }))).toBeUndefined();
    });

    test(`the key holds the sandbox, the extension and the revision, each apart`, () => {
        const revision = { kind: `commit`, value: COMMIT } as const;
        const key = bundleKeyOf(`sbx-1`, `maintenance`, revision);
        expect(new Set([key, bundleKeyOf(`sbx-2`, `maintenance`, revision), bundleKeyOf(`sbx-1`, `issues`, revision)]).size).toBe(3);
        expect(bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: OTHER_COMMIT })).not.toBe(key);
        expect(bundleKeyOf(`sbx-1`, `maintenance`, { kind: `dev`, value: COMMIT.slice(0, 12) })).not.toBe(bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: COMMIT.slice(0, 12) }));
        // An id cannot reach into another's prefix.
        expect(bundleKeyOf(`a/b`, `c`, revision)).not.toBe(bundleKeyOf(`a`, `b/c`, revision));
    });
});

describe(`a load pass`, () => {
    test(`a checkout's build is kept when it hashes to the revision listed, and read back`, async () => {
        const { entries, storage } = fakeStorage();
        const source = `export const activate = () => {};`;
        const summary = fromCheckout(source);
        const pass = bundlePass(`sbx-1`, () => true, storage);
        pass.fetched(summary, source);
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const key = bundleKeyOf(`sbx-1`, `maintenance`, { kind: `dev`, value: fingerprint(source) });
        expect([...entries.keys()]).toEqual([key]);
        expect(await bundlePass(`sbx-1`, () => true, storage).cached(summary)).toEqual({ key, source });
    });

    test(`a checkout rebuilt between the list and the fetch is not kept under the revision the list named`, async () => {
        const { entries, storage } = fakeStorage();
        const pass = bundlePass(`sbx-1`, () => true, storage);
        pass.fetched(fromCheckout(`the build the list hashed`), `the build that was served`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(entries.size).toBe(0);
    });

    test(`a pinned bundle waits for the list to name the same commit again, and is pruned past by the next commit`, async () => {
        const { entries, storage } = fakeStorage();
        const first = bundlePass(`sbx-1`, () => true, storage);
        first.fetched(pinned(), `commit one`);
        expect(entries.size).toBe(0);
        await first.settle(async () => [pinned()]);
        const oldKey = bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: COMMIT });
        expect(await sourceIn(entries, oldKey)).toBe(`commit one`);

        // Another extension, and the same one on another sandbox, are not pruned by a new commit of this one.
        const neighbours = bundlePass(`sbx-2`, () => true, storage);
        neighbours.fetched(pinned(), `commit one on sbx-2`);
        await neighbours.settle(async () => [pinned()]);
        const sibling = bundlePass(`sbx-1`, () => true, storage);
        sibling.fetched(pinned({ id: `issues` }), `issues`);
        await sibling.settle(async () => [pinned({ id: `issues` })]);

        const second = bundlePass(`sbx-1`, () => true, storage);
        second.fetched(pinned({ commit: OTHER_COMMIT }), `commit two`);
        await second.settle(async () => [pinned({ commit: OTHER_COMMIT })]);
        expect(entries.has(oldKey)).toBe(false);
        expect(await sourceIn(entries, bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: OTHER_COMMIT }))).toBe(`commit two`);
        expect(entries.size).toBe(3);
    });

    test(`a pinned bundle is not kept when the list read after the fetch says anything moved`, async () => {
        const moved: readonly (readonly [string, ServedSummary | undefined])[] = [
            [`an update landed`, pinned({ commit: OTHER_COMMIT })],
            [`a revert swapped the kept version`, pinned({ previous: { ref: OTHER_COMMIT } })],
            [`a dev pointer now serves a checkout`, fromCheckout(`checkout build`)],
            [`it was removed`, undefined],
        ];
        for (const [why, now] of moved) {
            const { entries, storage } = fakeStorage();
            const pass = bundlePass(`sbx-1`, () => true, storage);
            pass.fetched(pinned(), `fetched`);
            await pass.settle(async () => (now === undefined ? [] : [now]));
            expect({ why, kept: entries.size }).toEqual({ why, kept: 0 });
        }
        const { entries, storage } = fakeStorage();
        const pass = bundlePass(`sbx-1`, () => true, storage);
        pass.fetched(pinned(), `fetched`);
        await pass.settle(async () => {
            throw new Error(`unreachable`);
        });
        expect(entries.size).toBe(0);
    });

    test(`a pass for a sandbox no longer shown neither reads nor writes, and one with no sandbox or storage has no cache`, async () => {
        const { entries, storage, opened } = fakeStorage();
        let current = true;
        const pass = bundlePass(`sbx-1`, () => current, storage);
        pass.fetched(pinned(), `fetched`);
        current = false;
        await pass.settle(async () => [pinned()]);
        expect(await pass.cached(pinned())).toBeUndefined();
        pass.fetched(fromCheckout(`x`), `x`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(entries.size).toBe(0);
        expect(opened).toEqual([]);

        const nowhere = bundlePass(undefined, () => true, storage);
        nowhere.fetched(fromCheckout(`x`), `x`);
        expect(await nowhere.cached(fromCheckout(`x`))).toBeUndefined();
        expect(await bundlePass(`sbx-1`, () => true, undefined).cached(pinned())).toBeUndefined();
        expect(opened).toEqual([]);
    });

    test(`an entry that no longer hashes to what it was stored with is deleted and missed`, async () => {
        const { entries, storage } = fakeStorage();
        const pass = bundlePass(`sbx-1`, () => true, storage);
        pass.fetched(pinned(), `whole`);
        await pass.settle(async () => [pinned()]);
        const key = bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: COMMIT });
        const stored = entries.get(key);
        entries.set(key, new Response(`truncat`, { headers: stored?.headers ?? {} }));
        expect(await bundlePass(`sbx-1`, () => true, storage).cached(pinned())).toBeUndefined();
        expect(entries.has(key)).toBe(false);
    });
});

describe(`a cached copy that does not load`, () => {
    // What the loader's link step makes of a source: bundleLinkProblem, then import().
    const linker =
        (refuse: (source: string) => `unlinked` | `throws` | undefined) =>
        async (source: string): Promise<Linked<string>> => {
            const verdict = refuse(source);
            if (verdict === `throws`) {
                throw new SyntaxError(`Unexpected end of input`);
            }
            return verdict === `unlinked` ? { unlinked: `imports RepoRail from @intentic/extension-ui` } : { module: source };
        };

    const seeded = async (source: string): Promise<{ readonly entries: Map<string, Response>; readonly storage: BundleStorage }> => {
        const fake = fakeStorage();
        const pass = bundlePass(`sbx-1`, () => true, fake.storage);
        pass.fetched(pinned(), source);
        await pass.settle(async () => [pinned()]);
        return fake;
    };

    test(`is used without a fetch when it links and imports`, async () => {
        const { storage } = await seeded(`good`);
        let fetches = 0;
        const fetchFresh = async (): Promise<string> => {
            fetches += 1;
            return `fresh`;
        };
        const linked = await bundleModule(bundlePass(`sbx-1`, () => true, storage), pinned(), fetchFresh, linker(() => undefined));
        expect(linked).toEqual({ module: `good` });
        expect(fetches).toBe(0);
    });

    for (const failure of [`unlinked`, `throws`] as const) {
        test(`is deleted and fetched past once when it ${failure === `unlinked` ? `does not link` : `fails to import`}`, async () => {
            const { entries, storage } = await seeded(`corrupt`);
            let fetches = 0;
            const pass = bundlePass(`sbx-1`, () => true, storage);
            const linked = await bundleModule(
                pass,
                pinned(),
                async () => {
                    fetches += 1;
                    return `fresh`;
                },
                linker((source) => (source === `corrupt` ? failure : undefined)),
            );
            expect(linked).toEqual({ module: `fresh` });
            expect(fetches).toBe(1);
            const key = bundleKeyOf(`sbx-1`, `maintenance`, { kind: `commit`, value: COMMIT });
            expect(entries.has(key)).toBe(false);
            // The fresh copy replaces it once the list confirms the commit again.
            await pass.settle(async () => [pinned()]);
            expect(await sourceIn(entries, key)).toBe(`fresh`);
        });
    }

    test(`a fresh copy that does not link is reported, not retried and not kept`, async () => {
        const { entries, storage } = await seeded(`corrupt`);
        let fetches = 0;
        const pass = bundlePass(`sbx-1`, () => true, storage);
        const linked = await bundleModule(
            pass,
            pinned(),
            async () => {
                fetches += 1;
                return `stale build`;
            },
            linker(() => `unlinked`),
        );
        expect(linked).toEqual({ unlinked: `imports RepoRail from @intentic/extension-ui` });
        expect(fetches).toBe(1);
        await pass.settle(async () => [pinned()]);
        expect(entries.size).toBe(0);
    });
});

// Sign-out deletes the cache by name, since the client layer may not import the extension host: the two must agree.
test(`sign-out deletes the cache this module writes`, () => {
    const useAuth = readFileSync(join(packageRoot(import.meta.url), `src/client/auth/useAuth.ts`), `utf8`);
    expect(useAuth).toContain(`caches.delete(\`${EXTENSION_BUNDLE_CACHE}\`)`);
});
