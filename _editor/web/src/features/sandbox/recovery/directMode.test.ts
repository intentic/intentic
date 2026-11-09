import "@intentic/testing/dom";
import type { SandboxSummary, User } from "@intentic/api-contract";
import { ref } from "vue";
import { directMode } from "../../../client/directory/directState";
import type { RememberedAccount, RememberedSandbox } from "../../../client/directory/deviceDirectory";

// Pins opening a sandbox without the platform: the remembered list becomes the list, under the account that remembered
// it, and the platform is not asked for a list again until a session check it answers ends direct mode.

// The account switch is useAuth's; this suite stands in for it, the way the router does not need it to.
const authUser = ref<User | null>(null);
const enterDirect = jest.fn((account: User) => {
    directMode.value = true;
    authUser.value = account;
    return account;
});
// The session check the way back asks: the platform answering ends direct mode, as useAuth.ts does.
const refresh = jest.fn(async () => {
    directMode.value = false;
    return authUser.value;
});
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ enterDirect, refresh, user: authUser }) }));
// The platform is down: any list it is asked for fails, which is what direct mode must never trip over.
const list = jest.fn(async (): Promise<{ sandboxes: SandboxSummary[] }> => {
    throw new Error(`the platform cannot be reached`);
});
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { sandbox: { list } } }));

const { accountFromProof, enterDirectMode, enterFromMemory, pickRemembered, sandboxAt, summaryOf } = await import(`./directMode`);
const { useSandbox } = await import(`../../../client/sandbox/useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);
const { platformHealth } = await import(`../../../lib/platform/platformHealth`);

const user: User = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
const intentic: RememberedSandbox = {
    id: `s1`,
    name: `intentic`,
    image: `data:image/webp;base64,AAAA`,
    daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`,
    role: `owner`,
    hosted: false,
    lastSeenAt: `2026-10-01T18:00:09.479Z`,
    missingSince: `2026-10-02T12:00:00.000Z`,
};
const notes: RememberedSandbox = { ...intentic, id: `s2`, name: `notes`, daemonUrl: `https://sandbox-574ea8038415.sbx.intentic.dev`, lastSeenAt: null };
const account: RememberedAccount = { user, savedAt: `2026-10-02T12:00:00.000Z`, sandboxes: [intentic, notes] };

beforeEach(() => {
    directMode.value = false;
    authUser.value = null;
    enterDirect.mockClear();
    list.mockClear();
    queryClient.clear();
});

describe(`a remembered sandbox as a list row`, () => {
    it(`carries what the device remembers, no token, no hosted record, nothing reported`, () => {
        expect(summaryOf(intentic)).toEqual({
            id: `s1`,
            name: `intentic`,
            image: `data:image/webp;base64,AAAA`,
            daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`,
            lastSeenAt: `2026-10-01T18:00:09.479Z`,
            setupCodeClaimedAt: null,
            setupReport: null,
            bootReport: null,
            announceRefusal: null,
            removedAt: null,
            removedBy: null,
            token: null,
            role: `owner`,
            providedAddress: false,
            localHostname: null,
            hosted: null,
        });
    });

    // Remembered with its certified loopback name: the row carries it, so this computer is tried before the tunnel.
    it(`carries the certified loopback name the device remembered, and still no token`, () => {
        const here = summaryOf({ ...intentic, localId: `82789f4106b4`, localHostname: `82789f4106b4.local.example.com` });
        expect([here.localHostname, here.token]).toEqual([`82789f4106b4.local.example.com`, null]);
    });

    // A row without a last-seen time reads as a setup still to finish (setupGate.ts), which a sandbox opened is not.
    it(`gives a sandbox never seen the epoch as its last-seen time`, () => {
        expect(summaryOf(notes).lastSeenAt).toBe(`1970-01-01T00:00:00.000Z`);
    });
});

describe(`opening a sandbox directly`, () => {
    it(`signs in as the remembered account, makes the remembered list the list, and opens the sandbox`, async () => {
        enterDirectMode(account, notes);
        expect(enterDirect.mock.calls).toEqual([[user]]);
        const { list: listSandboxes, activeSandboxId } = useSandbox();
        expect((await listSandboxes()).map((row) => row.id)).toEqual([`s1`, `s2`]);
        expect(activeSandboxId.value).toBe(`s2`);
        // Neither the gate's list nor liveness's refresh asks the platform while it is down.
        await useSandbox().refresh();
        expect(list).not.toHaveBeenCalled();
    });

    it(`adds a sandbox known only by its address to the window's list`, async () => {
        const linked = sandboxAt(`https://sandbox-8a8171848c91.sbx.intentic.dev`);
        enterDirectMode(account, linked);
        expect((await useSandbox().list()).map((row) => row.id)).toEqual([`s1`, `s2`, `direct:sandbox-8a8171848c91.sbx.intentic.dev`]);
    });
});

// (2026-11-09) The platform not answering a session check opens the window on what the device remembers, unasked.
describe(`opening from memory without asking`, () => {
    // `intentic` is one the last list lacked (missingSince); `fresh` was listed but never checked in; `seen` was both.
    const { missingSince: _listed, ...listedEntry } = notes;
    const fresh: RememberedSandbox = { ...listedEntry, id: `s2`, name: `fresh`, lastSeenAt: null };
    const seen: RememberedSandbox = { ...listedEntry, id: `s3`, name: `seen`, lastSeenAt: `2026-10-01T10:00:00.000Z` };
    const three: RememberedAccount = { ...account, sandboxes: [intentic, fresh, seen] };

    it(`opens the sandbox the window had open, even one the last list lacked`, () => {
        expect(pickRemembered(three, { activeId: `s1` })?.id).toBe(`s1`);
    });

    it(`else the first still listed that has checked in, else the first still listed`, () => {
        expect(pickRemembered(three, {})?.id).toBe(`s3`);
        expect(pickRemembered({ ...account, sandboxes: [intentic, fresh] }, { activeId: `gone` })?.id).toBe(`s2`);
    });

    it(`opens only the sandbox an address names, and nothing for one it does not remember`, () => {
        expect(pickRemembered(three, { activeId: `s1`, daemonUrl: fresh.daemonUrl })?.id).toBe(`s2`);
        expect(pickRemembered(three, { daemonUrl: `https://sandbox-000000000000.sbx.intentic.dev` })).toBeUndefined();
    });

    it(`signs in as the remembered account and seeds its list`, async () => {
        expect(enterFromMemory(three, {})).toEqual(user);
        expect((await useSandbox().list()).map((row) => row.id)).toEqual([`s1`, `s2`, `s3`]);
        expect(useSandbox().activeSandboxId.value).toBe(`s3`);
        expect(list).not.toHaveBeenCalled();
    });

    it(`does nothing for a device that remembers no account, or nothing that fits`, () => {
        expect(enterFromMemory(undefined, {})).toBeUndefined();
        expect(enterFromMemory({ ...account, sandboxes: [] }, {})).toBeUndefined();
        expect(enterDirect).not.toHaveBeenCalled();
    });
});

// (code review, 2026-11-09) The session answering ends direct mode before the list is asked; a list that fails then is
// still owed, and asked again at the next recovery rather than never.
describe(`the way back`, () => {
    const settle = async (): Promise<void> => {
        for (let turn = 0; turn < 10; turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const recover = async (): Promise<void> => {
        platformHealth.noteStatus(503);
        platformHealth.noteStatus(200);
        await settle();
    };

    it(`asks for the list again after one that failed once the session answered, and then no more`, async () => {
        const defaults = queryClient.getDefaultOptions();
        // A failed list is drawn as failed at once rather than after the shared client's retries.
        queryClient.setDefaultOptions({ queries: { ...defaults.queries, retry: false } });
        enterFromMemory(account, {});
        await recover();
        expect([directMode.value, list.mock.calls.length]).toEqual([false, 1]);
        list.mockResolvedValueOnce({ sandboxes: [] });
        await recover();
        expect(list.mock.calls.length).toBe(2);
        await recover();
        expect(list.mock.calls.length).toBe(2);
        queryClient.setDefaultOptions(defaults);
    });
});

describe(`an account and a sandbox the device never listed`, () => {
    const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replaceAll(`=`, ``)}.s`;

    it(`names the account by the Google sign-in the daemon will check`, () => {
        expect(
            accountFromProof({ kind: `google`, idToken: token({ email: `owner@example.com`, exp: 9_999_999_999 }) }, new Date(`2026-10-02T12:00:00.000Z`)),
        ).toEqual({
            user: { id: `direct:owner@example.com`, email: `owner@example.com`, name: `owner@example.com`, image: null },
            savedAt: `2026-10-02T12:00:00.000Z`,
            sandboxes: [],
        });
        expect(accountFromProof({ kind: `google`, idToken: `not-a-token` })).toBeUndefined();
    });

    // An account that signs in by email has no Google sign-in to offer: the session the daemon minted (held already, or
    // opened by a passkey just now) says who it let in.
    it(`names the account by a daemon session when there is no Google sign-in`, () => {
        expect(accountFromProof({ kind: `session`, email: ` ana@corp.example ` }, new Date(`2026-10-02T12:00:00.000Z`))).toEqual({
            user: { id: `direct:ana@corp.example`, email: `ana@corp.example`, name: `ana@corp.example`, image: null },
            savedAt: `2026-10-02T12:00:00.000Z`,
            sandboxes: [],
        });
        expect(accountFromProof({ kind: `session`, email: `` })).toBeUndefined();
    });

    it(`names a sandbox by its host`, () => {
        expect(sandboxAt(`https://sandbox-8a8171848c91.sbx.intentic.dev`)).toEqual({
            id: `direct:sandbox-8a8171848c91.sbx.intentic.dev`,
            name: `sandbox-8a8171848c91.sbx.intentic.dev`,
            image: null,
            daemonUrl: `https://sandbox-8a8171848c91.sbx.intentic.dev`,
            role: `owner`,
            hosted: false,
            lastSeenAt: null,
        });
    });
});
