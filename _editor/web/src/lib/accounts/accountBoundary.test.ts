import { ACCOUNT_HEADER } from "@intentic/api-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import {
    ACCOUNT_POINTER_KEY,
    chatTabsKey,
    openAccountPartition,
    resetAccountPartitionForTests,
    type StoredJsonValue,
    storeValue,
} from "../../app/storage/browserStorage";

// The account boundary (accountBoundary.ts): a page is drawn for one account for its whole life, and every road to
// another account is a full navigation. Storage, the reload budget and the scope registry are the real ones; the
// browser's address and its channel between tabs are stand-ins, since jsdom can neither navigate nor broadcast.

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
    close(): void {
        FakeChannel.open.delete(this);
    }
}

// Before the boundary loads: the lifecycle module opens its channel at import.
stubGlobal(`BroadcastChannel`, FakeChannel);
const {
    AccountChangedError,
    accountExpectation,
    assertAccountCurrent,
    checkAnswerAccount,
    enterAccount,
    enterShell,
    leaveFor,
    leaveForNobody,
    noteShellRoute,
    pageAccount,
    resetAccountBoundaryForTests,
    setAccountReconciler,
} = await import(`./accountBoundary`);

const ADA = { id: `acc-a`, email: `ada@example.com` };
const BEA = { id: `acc-b`, email: `bea@example.com` };

// Where the page is and whether it reloaded, in place of jsdom's location, which cannot navigate.
const address = { href: `http://localhost:3000/sandbox/sbx-1`, protocol: `http:`, host: `localhost:3000`, reload: jest.fn() };

// Another tab of the same browser, listening on the channel the boundary announces on.
let otherTab: FakeChannel;
const heardElsewhere: StoredJsonValue[] = [];

// Lets a message sent on the fake channel arrive.
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

const answer = (status: number, headers: Record<string, string> = {}, body: string | null = null): Response => new Response(body, { status, headers });

beforeEach(() => {
    address.href = `http://localhost:3000/sandbox/sbx-1`;
    address.reload.mockReset();
    stubGlobal(`location`, address);
    heardElsewhere.length = 0;
    otherTab = new FakeChannel(`intentic.platform-auth`);
    otherTab.addEventListener(`message`, (event) => heardElsewhere.push(event.data));
});

afterEach(() => {
    otherTab.close();
    unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    resetAccountPartitionForTests();
    resetAccountBoundaryForTests();
});

// Every stored key of this name, whichever drawer it went into: a write that got through is in one of them.
const storedAnywhere = (name: string): readonly string[] => Object.keys(localStorage).filter((key) => key.endsWith(name));

describe(`entering an account`, () => {
    it(`draws the same account again without reloading`, () => {
        expect(enterAccount(ADA)).toBe(`entered`);
        expect(enterShell(`/sandbox/sbx-1`)).toBe(true);
        noteShellRoute(true);

        expect(enterAccount(ADA)).toBe(`entered`);
        expect(address.reload).not.toHaveBeenCalled();
        expect(pageAccount()).toEqual(ADA);
    });

    it(`adopts what was stored before anyone signed in as the first account's own, without reloading`, () => {
        localStorage.setItem(`intentic.activeSandboxId`, `sbx-legacy`);
        noteShellRoute(true);

        expect(enterAccount(ADA)).toBe(`entered`);

        expect(address.reload).not.toHaveBeenCalled();
        expect(localStorage.getItem(`intentic@acc-a/intentic.activeSandboxId`)).toBe(`sbx-legacy`);
        expect(localStorage.getItem(`intentic.activeSandboxId`)).toBeNull();
        expect(enterShell(`/sandbox/sbx-legacy`)).toBe(true);
    });

    it(`reloads once when the shell drawn for one account finds another signed in, and acts for neither after`, () => {
        enterAccount(ADA);
        enterShell(`/sandbox/sbx-1`);
        noteShellRoute(true);

        expect(enterAccount(BEA)).toBe(`reloading`);
        // A second answer on the way out does not start a second reload.
        expect(enterAccount(BEA)).toBe(`reloading`);

        expect(address.reload).toHaveBeenCalledTimes(1);
        // A debounced draft or a snapshot on the way out must not land in the drawer the next page opens.
        storeValue(chatTabsKey(`sbx-1`), `{"tabs":["late"]}`);
        expect(storedAnywhere(`intentic.chatTabs.sbx-1`)).toEqual([]);
        expect(() => assertAccountCurrent()).toThrow(AccountChangedError);
    });

    it(`follows another account in place outside the shell, and enters the shell by a full navigation`, () => {
        // The page read the first account's drawer at import, from the browser's pointer.
        localStorage.setItem(ACCOUNT_POINTER_KEY, ADA.id);
        resetAccountPartitionForTests();

        expect(enterAccount(BEA)).toBe(`entered`);
        expect(address.reload).not.toHaveBeenCalled();

        expect(enterShell(`/x`)).toBe(false);
        expect(address.href).toBe(`http://localhost:3000/x`);
        expect(address.reload).not.toHaveBeenCalled();
    });

    it(`stays as it is when the tab has reloaded itself too often, rather than reloading in a loop`, () => {
        const now = Date.now();
        sessionStorage.setItem(`intentic.automaticReloads`, [now, now, now].join(`,`));
        const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
        try {
            enterAccount(ADA);
            enterShell(`/sandbox/sbx-1`);
            noteShellRoute(true);

            expect(enterAccount(BEA)).toBe(`entered`);
            expect(enterAccount(BEA)).toBe(`entered`);

            expect(address.reload).not.toHaveBeenCalled();
            expect(() => assertAccountCurrent()).not.toThrow();
        } finally {
            warn.mockRestore();
        }
    });
});

describe(`leaving for another account`, () => {
    it(`points the browser at the next account, tells the other tabs, and navigates there`, async () => {
        enterAccount(ADA);

        leaveFor(BEA, `/`);
        await delivered();

        expect(localStorage.getItem(ACCOUNT_POINTER_KEY)).toBe(BEA.id);
        expect(heardElsewhere).toEqual([{ kind: `account-changed`, account: BEA.id }]);
        expect(address.href).toBe(`http://localhost:3000/`);
        expect(sessionStorage.getItem(`intentic.reloadReason`)).toStartWith(`account-switch|`);
        expect(pageAccount()).toBeUndefined();
        expect(() => assertAccountCurrent()).toThrow(AccountChangedError);
    });

    it(`goes Home rather than to another host a destination resolves to`, () => {
        enterAccount(ADA);

        // The URL parser drops the tab, so this rooted path is `//evil.example` by the time it navigates.
        leaveFor(BEA, `/\t/evil.example/phish`);
        expect(address.href).toBe(`http://localhost:3000/`);

        // A path that opens `//` once its dot segment goes stays a path on this host.
        leaveFor(BEA, `/.//evil.example`);
        expect(address.href).toBe(`http://localhost:3000//evil.example`);
    });

    it(`says nobody is signed in when it leaves for nobody`, async () => {
        enterAccount(ADA);

        leaveFor(undefined, `/login`);
        await delivered();

        expect(localStorage.getItem(ACCOUNT_POINTER_KEY)).toBeNull();
        expect(heardElsewhere).toEqual([{ kind: `account-changed`, account: null }]);
        expect(address.href).toBe(`http://localhost:3000/login`);
    });

    it(`stops writing and sending once every account here signed out, without navigating itself`, () => {
        enterAccount(ADA);

        leaveForNobody();

        expect(localStorage.getItem(ACCOUNT_POINTER_KEY)).toBeNull();
        storeValue(chatTabsKey(`sbx-1`), `late`);
        expect(storedAnywhere(`intentic.chatTabs.sbx-1`)).toEqual([]);
        expect(() => assertAccountCurrent()).toThrow(AccountChangedError);
        expect(address.href).toBe(`http://localhost:3000/sandbox/sbx-1`);
    });
});

describe(`checking an answer's account`, () => {
    it(`passes an answer made as this page's account, or naming nobody`, async () => {
        enterAccount(ADA);

        await expect(checkAnswerAccount(answer(200, { [ACCOUNT_HEADER]: ADA.id }))).resolves.toBeUndefined();
        await expect(checkAnswerAccount(answer(401))).resolves.toBeUndefined();
    });

    it(`refuses answers made as someone else, and asks who is signed in once however many arrive together`, async () => {
        let settle = (): void => undefined;
        const reconcile = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    settle = resolve;
                }),
        );
        setAccountReconciler(reconcile);
        enterAccount(ADA);

        const checks = await Promise.allSettled([1, 2, 3].map(async () => checkAnswerAccount(answer(200, { [ACCOUNT_HEADER]: BEA.id }))));

        expect(checks.map((check) => check.status === `rejected` && check.reason instanceof AccountChangedError)).toEqual([true, true, true]);
        expect(reconcile).toHaveBeenCalledTimes(1);
        settle();
    });

    it(`refuses a call the platform turned away as meant for another account`, async () => {
        enterAccount(ADA);
        const refused = answer(409, { "content-type": `application/json` }, JSON.stringify({ code: `ACCOUNT_CHANGED` }));

        await expect(checkAnswerAccount(refused)).rejects.toBeInstanceOf(AccountChangedError);
    });

    it(`leaves an ordinary conflict for the caller to read`, async () => {
        enterAccount(ADA);
        const conflict = answer(409, { "content-type": `application/json` }, JSON.stringify({ code: `CONFLICT`, message: `name taken` }));

        await expect(checkAnswerAccount(conflict)).resolves.toBeUndefined();
        // The body is still the caller's: the check read a copy.
        expect(await conflict.json()).toEqual({ code: `CONFLICT`, message: `name taken` });
        await expect(checkAnswerAccount(answer(409, {}, `not json`))).resolves.toBeUndefined();
    });
});

describe(`what a call says about its account`, () => {
    it(`names nothing before the page knows who is signed in`, () => {
        expect(accountExpectation(`POST`)).toEqual({});
    });

    it(`names the page's account on a call that changes something, and nothing on a read`, () => {
        enterAccount(ADA);

        expect(accountExpectation(`POST`)).toEqual({ [ACCOUNT_HEADER]: ADA.id });
        expect(accountExpectation(`GET`)).toEqual({});
        expect(accountExpectation(`HEAD`)).toEqual({});
    });
});

describe(`another tab moving the browser`, () => {
    it(`sends this page Home when another tab moved the browser to another account`, async () => {
        enterAccount(ADA);

        otherTab.send({ kind: `account-changed`, account: BEA.id });
        await delivered();

        expect(address.href).toBe(`http://localhost:3000/`);
        expect(() => assertAccountCurrent()).toThrow(AccountChangedError);
    });

    it(`sends this page Home when another tab signed everyone out`, async () => {
        enterAccount(ADA);

        otherTab.send({ kind: `account-changed`, account: null });
        await delivered();

        expect(address.href).toBe(`http://localhost:3000/`);
    });

    it(`stays where it is when it is already drawn for that account`, async () => {
        enterAccount(ADA);

        otherTab.send({ kind: `account-changed`, account: ADA.id });
        await delivered();

        expect(address.href).toBe(`http://localhost:3000/sandbox/sbx-1`);
        expect(() => assertAccountCurrent()).not.toThrow();
    });

    it(`stays where it is when it has not drawn an account yet and already reads that one's drawer`, async () => {
        openAccountPartition(BEA.id);

        otherTab.send({ kind: `account-changed`, account: BEA.id });
        await delivered();

        expect(address.href).toBe(`http://localhost:3000/sandbox/sbx-1`);
    });
});
