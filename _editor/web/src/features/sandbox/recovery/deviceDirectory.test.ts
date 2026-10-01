import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { mergeListed, type RememberedAccount, sandboxIdOfUrl } from "./deviceDirectory";

// Pins what the device remembers: every list as listed, never a forgetting a list implies (a platform that forgot the
// sandboxes lists nothing), a month's grace for the missing, a reset named by a database change, and nothing that
// carries a token.

const user = { id: `u1`, email: `Owner@Example.com`, name: `Owner`, image: null };
const NOW = new Date(`2026-10-02T12:00:00.000Z`);
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const listed = sandboxSummary({ id: `s1`, name: `intentic`, daemonUrl: `https://sandbox-82789f4106b4.sbx.intentic.dev/`, lastSeenAt: `2026-10-01T18:00:09.479Z` });
const other = sandboxSummary({ id: `s2`, name: `notes`, daemonUrl: `https://sandbox-574ea8038415.sbx.intentic.dev`, lastSeenAt: `2026-10-01T18:00:00.000Z` });

describe(`what a list leaves remembered`, () => {
    it(`remembers each addressed row by its normalized address, and no draft without one`, () => {
        const draft = sandboxSummary({ id: `draft` });
        expect(mergeListed(undefined, user, [listed, draft], `id-1`, NOW)).toEqual({
            user,
            identity: `id-1`,
            savedAt: NOW.toISOString(),
            sandboxes: [
                {
                    id: `s1`,
                    name: `intentic`,
                    image: null,
                    daemonUrl: `https://sandbox-82789f4106b4.sbx.intentic.dev`,
                    role: `owner`,
                    hosted: false,
                    lastSeenAt: `2026-10-01T18:00:09.479Z`,
                },
            ],
        });
    });

    it(`keeps a sandbox a list lacks, marked missing since that list, rather than forgetting it`, () => {
        const before = mergeListed(undefined, user, [listed, other], `id-1`, NOW);
        const after = mergeListed(before, user, [listed], `id-1`, at(DAY_MS));
        expect(after.sandboxes.map((entry) => [entry.id, entry.missingSince])).toEqual([
            [`s1`, undefined],
            [`s2`, at(DAY_MS).toISOString()],
        ]);
        // A later list that still lacks it keeps the first moment it went missing.
        const later = mergeListed(after, user, [listed], `id-1`, at(5 * DAY_MS));
        expect(later.sandboxes[1]?.missingSince).toBe(at(DAY_MS).toISOString());
    });

    it(`lets go of a sandbox missing for a month`, () => {
        const before = mergeListed(undefined, user, [listed, other], `id-1`, NOW);
        const missing = mergeListed(before, user, [listed], `id-1`, NOW);
        expect(mergeListed(missing, user, [listed], `id-1`, at(30 * DAY_MS - 1)).sandboxes.map((entry) => entry.id)).toEqual([`s1`, `s2`]);
        expect(mergeListed(missing, user, [listed], `id-1`, at(30 * DAY_MS)).sandboxes.map((entry) => entry.id)).toEqual([`s1`]);
    });

    it(`clears the missing mark once a list shows the sandbox again`, () => {
        const missing = mergeListed(mergeListed(undefined, user, [listed, other], `id-1`, NOW), user, [listed], `id-1`, NOW);
        expect(mergeListed(missing, user, [listed, other], `id-1`, at(DAY_MS)).sandboxes.map((entry) => entry.missingSince)).toEqual([undefined, undefined]);
    });

    // An empty list from another database is a reset, not a new account: the moment is kept until nothing is missing.
    it(`names a reset when a list comes from another database, until nothing is missing`, () => {
        const before = mergeListed(undefined, user, [listed], `id-1`, NOW);
        const reset = mergeListed(before, user, [], `id-2`, at(DAY_MS));
        expect([reset.identity, reset.resetSince]).toEqual([`id-2`, at(DAY_MS).toISOString()]);
        expect(mergeListed(reset, user, [], `id-2`, at(2 * DAY_MS)).resetSince).toBe(at(DAY_MS).toISOString());
        expect(mergeListed(reset, user, [listed], `id-2`, at(3 * DAY_MS)).resetSince).toBeUndefined();
    });

    it(`keeps the identity it knew when a platform cannot say which database it reads`, () => {
        const before: RememberedAccount = mergeListed(undefined, user, [listed], `id-1`, NOW);
        expect(mergeListed(before, user, [listed], undefined, NOW).identity).toBe(`id-1`);
    });
});

describe(`the hostname's sandbox id`, () => {
    it(`reads the 12-hex id off an address of ours, and nothing off a domain of the owner's own`, () => {
        expect(sandboxIdOfUrl(`https://sandbox-82789f4106b4.radarsu.com`)).toBe(`82789f4106b4`);
        expect(sandboxIdOfUrl(`https://sandbox.example.com`)).toBeUndefined();
        expect(sandboxIdOfUrl(`https://preview-82789f4106b4.sbx.intentic.dev`)).toBeUndefined();
    });
});

// The stored half, against the page's own localStorage: a fresh module per test, since it reads storage once on load.
describe(`the device's memory`, () => {
    beforeEach(() => {
        localStorage.clear();
    });
    const load = (): Promise<typeof import("./deviceDirectory")> => freshImport("./deviceDirectory", import.meta.url);

    it(`offers an account's own missing sandboxes for recovery, and a share alone for nothing`, async () => {
        const directory = await load();
        const shared = sandboxSummary({ id: `s3`, role: `writer`, daemonUrl: `https://sandbox-1ea6479e2362.sbx.intentic.dev`, lastSeenAt: `2026-10-01T00:00:00.000Z` });
        directory.rememberListed(user, [listed, shared], `id-1`, NOW);
        directory.rememberListed(user, [listed], `id-1`, NOW);
        expect(directory.ownsMissingSandboxes(`owner@example.com`)).toBe(false);
        directory.rememberListed(user, [], `id-1`, NOW);
        expect(directory.ownsMissingSandboxes(`owner@example.com`)).toBe(true);
        expect(directory.missingSandboxes(`OWNER@example.com`).map((entry) => entry.id)).toEqual([`s1`, `s3`]);
    });

    it(`answers for the account that listed last when none is named, and survives a reload`, async () => {
        (await load()).rememberListed(user, [listed], `id-1`, NOW);
        const reloaded = await load();
        expect(reloaded.rememberedAccount()?.user).toEqual(user);
        expect(reloaded.rememberedAccount(`owner@example.com`)?.sandboxes.map((entry) => entry.id)).toEqual([`s1`]);
    });

    it(`forgets a sandbox, an address on every account, and a whole account`, async () => {
        const directory = await load();
        const second = { ...user, id: `u2`, email: `second@example.com` };
        directory.rememberListed(user, [listed, other], `id-1`, NOW);
        directory.rememberListed(second, [listed], `id-1`, NOW);
        directory.forgetSandbox(`owner@example.com`, `https://sandbox-574ea8038415.sbx.intentic.dev`);
        expect(directory.rememberedAccount(`owner@example.com`)?.sandboxes.map((entry) => entry.id)).toEqual([`s1`]);
        directory.forgetAddress(`https://sandbox-82789f4106b4.sbx.intentic.dev/`);
        expect(directory.rememberedAccount(`owner@example.com`)?.sandboxes).toEqual([]);
        expect(directory.rememberedAccount(`second@example.com`)?.sandboxes).toEqual([]);
        directory.forgetAccount(`second@example.com`);
        expect(directory.rememberedAccount(`second@example.com`)).toBeUndefined();
        expect(directory.rememberedAccount()).toBeUndefined();
    });

    it(`marks a missing sandbox the platform has no record of, the standing recovery offers back`, async () => {
        const directory = await load();
        directory.rememberListed(user, [listed], `id-1`, NOW);
        directory.rememberListed(user, [], `id-1`, NOW);
        directory.noteUnknown(`owner@example.com`, `https://sandbox-82789f4106b4.sbx.intentic.dev`);
        expect(directory.missingSandboxes(`owner@example.com`).map((entry) => entry.standing)).toEqual([`unknown`]);
    });

    it(`reads a stored value it cannot parse as nothing remembered`, async () => {
        localStorage.setItem(`intentic.deviceDirectory`, `{"version":9}`);
        expect((await load()).rememberedAccount()).toBeUndefined();
        localStorage.setItem(`intentic.deviceDirectory`, `not json`);
        expect((await load()).rememberedAccount()).toBeUndefined();
    });

    it(`never stores a token`, async () => {
        (await load()).rememberListed(user, [{ ...listed, token: `connect-token-secret` }], `id-1`, NOW);
        expect(localStorage.getItem(`intentic.deviceDirectory`)).not.toContain(`connect-token-secret`);
    });
});
