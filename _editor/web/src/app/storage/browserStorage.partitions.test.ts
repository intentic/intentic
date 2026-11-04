import {
    ACCOUNT_POINTER_KEY,
    accountPartition,
    chatTabsKey,
    clearAccountStorage,
    clearEveryAccountStorage,
    daemonSessionKey,
    deviceKey,
    googleCredentialKey,
    onAccountCleared,
    openAccountPartition,
    resetAccountPartitionForTests,
    storedKeys,
    storedValue,
    storeValue,
} from "./browserStorage";

// Each account's drawer (@intentic/ui/storage): the same names read and written by every store, kept per account, so
// two accounts on one browser never read each other's, and switching back finds the first as it was left.

const THEME = deviceKey(`ui-theme`);

beforeEach(() => {
    resetAccountPartitionForTests();
});

afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetAccountPartitionForTests();
});

describe("one drawer per account", () => {
    it("keeps an account's keys in its own drawer and the device's under their own names", () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `{"tabs":["a"]}`);
        storeValue(THEME, `dark`);

        expect(localStorage.getItem(`intentic@acc-a/intentic.chatTabs.sbx-1`)).toBe(`{"tabs":["a"]}`);
        expect(localStorage.getItem(`intentic.chatTabs.sbx-1`)).toBeNull();
        expect(localStorage.getItem(THEME)).toBe(`dark`);
    });

    it("never lets one account read another's, and gives the first back as it was left", () => {
        openAccountPartition(`acc-a`);
        storeValue(daemonSessionKey(`sbx-shared`), `{"token":"a-token"}`);
        storeValue(googleCredentialKey(`client`), `a-google`);

        openAccountPartition(`acc-b`);
        expect([storedValue(daemonSessionKey(`sbx-shared`)), storedValue(googleCredentialKey(`client`))]).toEqual([undefined, undefined]);
        storeValue(daemonSessionKey(`sbx-shared`), `{"token":"b-token"}`);

        openAccountPartition(`acc-a`);
        expect([storedValue(daemonSessionKey(`sbx-shared`)), storedValue(googleCredentialKey(`client`))]).toEqual([`{"token":"a-token"}`, `a-google`]);
    });

    it("lists only the open account's keys beside the device's, by the names they were stored under", () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`);
        openAccountPartition(`acc-b`);
        storeValue(chatTabsKey(`sbx-2`), `b`);
        storeValue(THEME, `light`);

        expect(storedKeys(`intentic.chatTabs.`)).toEqual([`intentic.chatTabs.sbx-2`]);
        expect(storedKeys(``).toSorted()).toEqual([ACCOUNT_POINTER_KEY, `intentic.chatTabs.sbx-2`, THEME].toSorted());
    });

    it("keeps this tab's session area in drawers too", () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`, `session`);
        openAccountPartition(`acc-b`);

        expect(storedValue(chatTabsKey(`sbx-1`), `session`)).toBeUndefined();
        expect(sessionStorage.getItem(`intentic@acc-a/intentic.chatTabs.sbx-1`)).toBe(`a`);
    });

    it("reads which drawer is open from the pointer, before anything is opened in this page", () => {
        localStorage.setItem(ACCOUNT_POINTER_KEY, `acc-a`);
        localStorage.setItem(`intentic@acc-a/intentic.activeSandboxId`, `sbx-9`);
        resetAccountPartitionForTests();

        expect(accountPartition()).toBe(`acc-a`);
        expect(storedValue(`intentic.activeSandboxId`)).toBe(`sbx-9`);
    });

    it("escapes an id that could reach past its own drawer", () => {
        openAccountPartition(`../acc-b`);
        storeValue(chatTabsKey(`sbx-1`), `x`);

        expect(Object.keys(localStorage).filter((key) => key.startsWith(`intentic@`))).toEqual([`intentic@..%2Facc-b/intentic.chatTabs.sbx-1`]);
    });
});

describe("opening a drawer", () => {
    it("adopts the account keys no drawer holds, and says nothing read needs putting right", () => {
        storeValue(chatTabsKey(`sbx-1`), `from-before`);
        storeValue(THEME, `dark`);

        const opened = openAccountPartition(`acc-a`);

        expect(opened.stale).toBe(false);
        expect(storedValue(chatTabsKey(`sbx-1`))).toBe(`from-before`);
        expect(localStorage.getItem(`intentic.chatTabs.sbx-1`)).toBeNull();
        expect(localStorage.getItem(THEME)).toBe(`dark`);
    });

    it("never adopts over a value the drawer already holds, and then says the page must reload", () => {
        localStorage.setItem(`intentic@acc-a/intentic.activeSandboxId`, `sbx-a`);
        localStorage.setItem(`intentic.activeSandboxId`, `sbx-signed-out`);

        const opened = openAccountPartition(`acc-a`);

        expect(opened.stale).toBe(true);
        expect(storedValue(`intentic.activeSandboxId`)).toBe(`sbx-a`);
        expect(localStorage.getItem(`intentic.activeSandboxId`)).toBeNull();
    });

    it("says a page that read another account's drawer must reload, and one that opened its own need not", () => {
        openAccountPartition(`acc-a`);
        expect(openAccountPartition(`acc-a`).stale).toBe(false);
        expect(openAccountPartition(`acc-b`).stale).toBe(true);
    });

    it("closes every drawer for nobody, pointing the browser at no account", () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`);

        openAccountPartition(undefined);

        expect([accountPartition(), localStorage.getItem(ACCOUNT_POINTER_KEY), storedValue(chatTabsKey(`sbx-1`))]).toEqual([undefined, null, undefined]);
        expect(localStorage.getItem(`intentic@acc-a/intentic.chatTabs.sbx-1`)).toBe(`a`);
    });
});

describe("clearing", () => {
    it("clears one account's drawer and leaves the others and the device's", async () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`);
        storeValue(chatTabsKey(`sbx-1`), `a`, `session`);
        openAccountPartition(`acc-b`);
        storeValue(chatTabsKey(`sbx-1`), `b`);
        storeValue(THEME, `dark`);

        await clearAccountStorage(`acc-a`);

        expect(Object.keys(localStorage).toSorted()).toEqual([ACCOUNT_POINTER_KEY, `intentic@acc-b/intentic.chatTabs.sbx-1`, THEME].toSorted());
        expect(Object.keys(sessionStorage)).toEqual([]);
    });

    it("clears the open account's drawer when none is named", async () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`);

        await clearAccountStorage();

        expect(storedValue(chatTabsKey(`sbx-1`))).toBeUndefined();
    });

    it("clears every drawer for every account, and only the device's stay", async () => {
        openAccountPartition(`acc-a`);
        storeValue(chatTabsKey(`sbx-1`), `a`);
        openAccountPartition(`acc-b`);
        storeValue(chatTabsKey(`sbx-1`), `b`);
        localStorage.setItem(`intentic.chatTabs.sbx-2`, `nobody's`);
        storeValue(THEME, `dark`);

        await clearEveryAccountStorage();

        expect(Object.keys(localStorage).toSorted()).toEqual([ACCOUNT_POINTER_KEY, THEME].toSorted());
    });

    it("tells each clearer which account went, and nobody's for every account", async () => {
        const told: (string | undefined)[] = [];
        const stop = onAccountCleared((account) => {
            told.push(account);
        });
        try {
            openAccountPartition(`acc-a`);
            await clearAccountStorage();
            await clearAccountStorage(`acc-b`);
            await clearEveryAccountStorage();
        } finally {
            stop();
        }
        expect(told).toEqual([`acc-a`, `acc-b`, undefined]);
    });
});
