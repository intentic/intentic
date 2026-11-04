import { freshImport, stubGlobal } from "@intentic/testing/bun";
import { computed, ref } from "vue";
import { openAccountPartition, resetAccountPartitionForTests, type StoredJsonValue } from "../../app/storage/browserStorage";

// Daemon sessions are each account's own (sandboxSession.ts): two accounts that can both open a sandbox each keep the
// session minted for them, and a tab never takes in a session another tab wrote for a different account. Storage and its
// drawers are the real ones; the channel between tabs is a stand-in, since jsdom has none that delivers.

// Every channel of one name in this browser, as the tabs hold them: a message reaches each of the others, never the one
// that sent it, and arrives as a copy a little later, as the real one does.
type Heard = (event: { readonly data: StoredJsonValue }) => void;
class FakeChannel {
    static readonly open = new Set<FakeChannel>();
    private readonly listeners = new Set<Heard>();
    constructor(readonly name: string) {
        FakeChannel.open.add(this);
    }
    postMessage(message: StoredJsonValue): void {
        this.send(message);
    }
    // What a test has another tab say. Its own name, since a call named postMessage reads to the linter as a window's,
    // which wants a target origin a channel does not have.
    send(message: StoredJsonValue): void {
        const copy = structuredClone(message);
        for (const other of FakeChannel.open) {
            if (other !== this && other.name === this.name) {
                queueMicrotask(() => {
                    for (const listener of other.listeners) {
                        listener({ data: copy });
                    }
                });
            }
        }
    }
    addEventListener(_type: string, listener: Heard): void {
        this.listeners.add(listener);
    }
    removeEventListener(_type: string, listener: Heard): void {
        this.listeners.delete(listener);
    }
}

// Kept for the whole file: each fresh copy of the session module opens its channel as it loads.
stubGlobal(`BroadcastChannel`, FakeChannel);

// Nothing here establishes a session, so the ways of proving one are inert.
jest.mock(`./passkeySignIn`, () => ({ passkeyOffered: async () => false }));
jest.mock(`../auth/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({
        getIdToken: async () => undefined,
        signedInEmail: ref(undefined),
        clearCredential: () => undefined,
        cancelSignIn: () => undefined,
    }),
}));
jest.mock(`../../lib/useApi`, () => ({ apiClient: {} }));
jest.mock(`../sandbox/useSandbox`, () => {
    const activeSandboxId = ref(`sb-1`);
    return {
        useSandbox: () => ({
            active: computed(() => ({ id: activeSandboxId.value, token: `connect` })),
            activeSandboxId,
            daemonUrl: { value: `https://daemon.test` },
        }),
    };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionOf = (email: string, token: string) => ({ token, expiresAt: Date.now() + 30 * DAY_MS, email });
const ADA_SESSION = sessionOf(`ada@example.com`, `ada-token`);
const BEA_SESSION = sessionOf(`bea@example.com`, `bea-token`);
const TARGET = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };

// A page loading afresh: its own copy of the session module, and the only tab on the channel until another joins.
const load = async () => {
    FakeChannel.open.clear();
    const { useSandboxSession } = await freshImport<typeof import("./sandboxSession")>(`./sandboxSession`, import.meta.url);
    return useSandboxSession();
};

// Lets a message sent on the fake channel arrive.
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

// Every daemon session this browser keeps, in whichever drawer.
const storedSessions = (): readonly string[] => Object.keys(localStorage).filter((key) => key.includes(`intentic.session.`));

beforeEach(() => {
    resetAccountPartitionForTests();
    openAccountPartition(`acc-a`);
});

afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetAccountPartitionForTests();
});

describe(`what another tab says about sessions`, () => {
    it(`ignores a session another tab wrote for another account`, async () => {
        const sessions = await load();
        const otherTab = new FakeChannel(`intentic.sandbox-auth`);

        otherTab.send({ kind: `write`, sandboxId: `sb-1`, session: BEA_SESSION, account: `acc-b` });
        await delivered();

        expect(sessions.heldSessionEmail(`sb-1`)).toBeUndefined();
        expect(storedSessions()).toEqual([]);
    });

    it(`takes in a session another tab wrote for this account`, async () => {
        const sessions = await load();
        const otherTab = new FakeChannel(`intentic.sandbox-auth`);

        otherTab.send({ kind: `write`, sandboxId: `sb-1`, session: ADA_SESSION, account: `acc-a` });
        await delivered();

        expect(sessions.heldSessionEmail(`sb-1`)).toBe(`ada@example.com`);
        expect(localStorage.getItem(`intentic@acc-a/intentic.session.sb-1`)).toContain(`ada-token`);
    });

    it(`takes in a session from a tab that names no account, as tabs from before accounts had drawers send`, async () => {
        const sessions = await load();
        const otherTab = new FakeChannel(`intentic.sandbox-auth`);

        otherTab.send({ kind: `write`, sandboxId: `sb-1`, session: ADA_SESSION });
        await delivered();

        expect(sessions.heldSessionEmail(`sb-1`)).toBe(`ada@example.com`);
    });

    it(`keeps its own sessions when another account's tab clears or drops theirs`, async () => {
        const sessions = await load();
        sessions.adoptSession(`sb-1`, ADA_SESSION);
        const otherTab = new FakeChannel(`intentic.sandbox-auth`);

        otherTab.send({ kind: `invalidate`, sandboxId: `sb-1`, account: `acc-b` });
        otherTab.send({ kind: `clear`, account: `acc-b` });
        await delivered();

        expect(sessions.heldSessionEmail(`sb-1`)).toBe(`ada@example.com`);
        expect(storedSessions()).toEqual([`intentic@acc-a/intentic.session.sb-1`]);
    });
});

describe(`two accounts on one sandbox`, () => {
    it(`keeps each account's session apart, and gives the first its own back`, async () => {
        const ada = await load();
        ada.adoptSession(`sb-1`, ADA_SESSION);

        // The browser moves to the second account, and its page loads afresh.
        openAccountPartition(`acc-b`);
        const bea = await load();
        expect(bea.heldSessionEmail(`sb-1`)).toBeUndefined();
        bea.adoptSession(`sb-1`, BEA_SESSION);
        expect(await bea.getSessionToken(TARGET)).toEqual({ token: `bea-token`, kind: `session` });

        // Forgetting the second account's sessions leaves the first's where it was.
        bea.clearSessions();
        expect(storedSessions()).toEqual([`intentic@acc-a/intentic.session.sb-1`]);

        openAccountPartition(`acc-a`);
        const adaAgain = await load();
        expect(await adaAgain.getSessionToken(TARGET)).toEqual({ token: `ada-token`, kind: `session` });
    });
});
