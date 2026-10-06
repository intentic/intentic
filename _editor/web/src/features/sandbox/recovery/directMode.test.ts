import "@intentic/testing/dom";
import type { User } from "@intentic/api-contract";
import { directMode } from "../../../client/directory/directState";
import type { RememberedAccount, RememberedSandbox } from "../../../client/directory/deviceDirectory";

// Pins opening a sandbox without the platform: the remembered list becomes the list, under the account that remembered
// it, and the platform is not asked for a list again until a session check it answers ends direct mode.

// The account switch is useAuth's; this suite stands in for it, the way the router does not need it to.
const enterDirect = jest.fn((account: User) => {
    directMode.value = true;
    return account;
});
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ enterDirect, user: { value: null } }) }));
// The platform is down: any list it is asked for fails, which is what direct mode must never trip over.
const list = jest.fn(async () => {
    throw new Error(`the platform cannot be reached`);
});
jest.mock(`../../../lib/useApi`, () => ({ apiClient: { sandbox: { list } } }));

const { accountFromGoogle, enterDirectMode, sandboxAt, summaryOf } = await import(`./directMode`);
const { useSandbox } = await import(`../../../client/sandbox/useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);

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

describe(`an account and a sandbox the device never listed`, () => {
    const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replaceAll(`=`, ``)}.s`;

    it(`names the account by the Google sign-in the daemon will check`, () => {
        expect(accountFromGoogle(token({ email: `owner@example.com`, exp: 9_999_999_999 }), new Date(`2026-10-02T12:00:00.000Z`))).toEqual({
            user: { id: `direct:owner@example.com`, email: `owner@example.com`, name: `owner@example.com`, image: null },
            savedAt: `2026-10-02T12:00:00.000Z`,
            sandboxes: [],
        });
        expect(accountFromGoogle(`not-a-token`)).toBeUndefined();
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
