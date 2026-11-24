// Pins how a window keeps the reader's look with their account: the account's copy is worn wherever this device holds
// another, a device meeting the account for the first time offers what the account lacks (once, and never a look nobody
// chose), a choice made here goes up with whatever was chosen beside it, and nothing happens without a platform account
// behind the window or to the look the Android app hands its page.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync, freshImport, realYield } from "@intentic/testing/bun";
import { ACCOUNT_PREFERENCE_NAME, ACCOUNT_PREFERENCES_MAX, type AccountPreferences, type AccountPreferencesPatch } from "@intentic/api-contract";
import { boolPreference, definePreference, receivePreferenceChange, storedPreference } from "@intentic/ui/preference";
import { openAccountPartition, resetAccountPartitionForTests } from "@intentic/ui/storage";
import { ORPCError } from "@orpc/client";
import { type Ref, ref } from "vue";

// Whether this page is the Android app's WebView, per test.
let inApp = false;
jest.mock(`./environments/nativeApp`, () => ({ embedded: () => inApp }));

// What this window holds, under the names the editor stores them by. Every test starts them at what nothing stored
// reads as.
const scheme = definePreference<string>({ key: `ui-color-scheme`, read: (raw) => raw ?? `system`, write: (value) => value });
const skin = definePreference<string>({ key: `ui-skin`, read: (raw) => raw ?? `system`, write: (value) => value });
const textSize = definePreference<string>({ key: `ui-text-size`, read: (raw) => raw ?? `compact`, write: (value) => value });
// A default stored as nothing, as a preference that keeps no value for its default does.
const gauges = definePreference<string>({ key: `ui-agents-live-metrics`, read: (raw) => raw ?? `system`, write: (value) => (value === `system` ? null : value) });
const audience = definePreference<string>({ key: `ui-audience`, read: (raw) => raw ?? `developer`, write: (value) => value });
// No stored language reads as the browser's own, as @intentic/ui/i18n reads it.
const locale = definePreference<string>({ key: `ui-locale`, read: (raw) => raw ?? `en`, write: (value) => value });
// The file tree's test filter, as workbench/window/useLayout.ts declares it.
const hideTests = boolPreference(`ui-workspace-hide-tests`);

// The platform as it keeps an account's preferences: a read answers the whole set, a patch merges into it and answers
// the set after. `refusal` fails every call; `holdReads` keeps a read unanswered until released.
interface Kept {
    readonly values: Map<string, string>;
    readonly patches: AccountPreferencesPatch[`values`][];
    reads: number;
    writes: number;
    refusal: Error | undefined;
    readonly holdReads: () => () => void;
    readonly preferences: () => Promise<AccountPreferences>;
    readonly setPreferences: (patch: AccountPreferencesPatch) => Promise<AccountPreferences>;
}

const keeping = (held: Readonly<Record<string, string>> = {}): Kept => {
    let gate: Promise<void> | undefined;
    const kept: Kept = {
        values: new Map(Object.entries(held)),
        patches: [],
        reads: 0,
        writes: 0,
        refusal: undefined,
        holdReads: () => {
            const { promise, resolve } = Promise.withResolvers<void>();
            gate = promise;
            return resolve;
        },
        preferences: async () => {
            kept.reads += 1;
            await gate;
            if (kept.refusal !== undefined) {
                throw kept.refusal;
            }
            return { values: Object.fromEntries(kept.values) };
        },
        setPreferences: async ({ values }) => {
            kept.writes += 1;
            if (kept.refusal !== undefined) {
                throw kept.refusal;
            }
            kept.patches.push(values);
            for (const [key, raw] of Object.entries(values)) {
                if (raw === null) {
                    kept.values.delete(key);
                } else {
                    kept.values.set(key, raw);
                }
            }
            return { values: Object.fromEntries(kept.values) };
        },
    };
    return kept;
};

// Every window started by a test, signed out once it ends: their listeners stay, and must hear nothing of the next one.
const accounts: Ref<{ id: string } | null>[] = [];

// Every preference this window holds, by key.
const HELD = [`ui-color-scheme`, `ui-skin`, `ui-text-size`, `ui-agents-live-metrics`, `ui-audience`, `ui-locale`, `ui-workspace-hide-tests`];

// A page moving to another account (or to nobody) is a full navigation (lib/accounts/accountBoundary.ts): it opens that
// drawer and every preference reads again from it, as a fresh load would.
const reloadAs = (id: string | undefined): void => {
    openAccountPartition(id);
    for (const key of HELD) {
        receivePreferenceChange({ key, raw: storedPreference(key) });
    }
};

// One window's sync, fresh, signed in as `id` (null: nobody), with its first read answered.
const start = async (kept: Kept, id: string | null = `account-1`): Promise<Ref<{ id: string } | null>> => {
    const account = ref(id === null ? null : { id });
    accounts.push(account);
    // The page opens the account's own drawer first, so what it keeps is its own.
    if (id !== null) {
        reloadAs(id);
    }
    const { startAccountPreferences } = await freshImport<typeof import("./accountPreferences")>("./accountPreferences", import.meta.url);
    startAccountPreferences(account, kept);
    await realYield();
    return account;
};

const AFTER_A_WHILE = 5 * 60_000;

const comeBack = async (): Promise<void> => {
    globalThis.dispatchEvent(new Event(`focus`));
    await realYield();
};

beforeEach(() => {
    localStorage.clear();
    resetAccountPartitionForTests();
    receivePreferenceChange({ key: null, raw: null });
});

afterEach(() => {
    for (const account of accounts) {
        account.value = null;
    }
    accounts.length = 0;
    inApp = false;
    window.__INTENTIC_SANDBOX_FACE__ = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test(`the account's preferences are worn wherever this device holds others, and nothing goes back for them`, async () => {
    localStorage.setItem(`ui-color-scheme`, `light`);
    localStorage.setItem(`ui-text-size`, `large`);
    const kept = keeping({ "ui-color-scheme": `dark`, "ui-text-size": `large`, "ui-agents-live-metrics": `off` });

    await start(kept);

    expect(scheme.value).toBe(`dark`);
    expect(gauges.value).toBe(`off`);
    expect(storedPreference(`ui-color-scheme`)).toBe(`dark`);
    expect(storedPreference(`ui-agents-live-metrics`)).toBe(`off`);
    expect(kept.writes).toBe(0);
});

test(`a device meeting the account first offers what the account lacks in one patch, but no look nobody chose`, async () => {
    localStorage.setItem(`ui-wallpaper`, `valley`);
    localStorage.setItem(`ui-locale`, `pl`);
    localStorage.setItem(`ui-agents-live-metrics`, `off`);
    // What the Theme row stores for "System", and what a profile link left in many a browser before anyone chose.
    localStorage.setItem(`ui-color-scheme`, `system`);
    localStorage.setItem(`ui-skin`, `system`);
    // None of these is the account's to keep.
    localStorage.setItem(`ui-audience`, `maker`);
    localStorage.setItem(`ui-profile`, `desk`);
    const kept = keeping({ "ui-text-size": `large` });

    await start(kept);

    expect(kept.patches).toEqual([{ "ui-wallpaper": `valley`, "ui-locale": `pl`, "ui-agents-live-metrics": `off` }]);
    expect(storedPreference(`ui-text-size`)).toBe(`large`);
});

test(`only the first meeting offers, so what the account has forgotten since stays forgotten`, async () => {
    localStorage.setItem(`ui-agents-live-metrics`, `off`);
    const kept = keeping();
    const first = await start(kept);
    expect(kept.patches).toEqual([{ "ui-agents-live-metrics": `off` }]);

    // Another device went back to following the OS, which the account keeps as nothing at all; then this device loads again.
    kept.values.delete(`ui-agents-live-metrics`);
    first.value = null;
    await start(kept);

    expect(kept.reads).toBe(2);
    expect(kept.patches).toHaveLength(1);
    // This device's own stands, as the platform's contract says of a preference it no longer keeps.
    expect(storedPreference(`ui-agents-live-metrics`)).toBe(`off`);
});

test(`another account's choices are not worn by the next one in, nor offered to it`, async () => {
    jest.useFakeTimers();
    const first = keeping();
    const one = await start(first, `account-1`);
    locale.value = `pl`;
    textSize.value = `large`;
    await advanceTimersByTimeAsync(500);
    expect(Object.fromEntries(first.values)).toEqual({ "ui-locale": `pl`, "ui-text-size": `large` });

    // The browser moves to another account, which chose a text size of its own and never a language.
    one.value = null;
    const second = keeping({ "ui-text-size": `compact` });
    await start(second, `account-2`);

    expect(locale.value).toBe(`en`);
    expect(storedPreference(`ui-locale`)).toBeNull();
    expect(textSize.value).toBe(`compact`);
    expect(second.writes).toBe(0);
    expect(Object.fromEntries(second.values)).toEqual({ "ui-text-size": `compact` });
});

test(`an account coming back wears its own again, and a choice it made on the way stays its own`, async () => {
    jest.useFakeTimers();
    const first = keeping({ "ui-locale": `pl` });
    const one = await start(first, `account-1`);
    expect(locale.value).toBe(`pl`);
    one.value = null;

    const second = keeping();
    const two = await start(second, `account-2`);
    expect(locale.value).toBe(`en`);
    locale.value = `de`;
    await advanceTimersByTimeAsync(500);
    two.value = null;

    await start(first, `account-1`);
    expect(locale.value).toBe(`pl`);
    expect(Object.fromEntries(second.values)).toEqual({ "ui-locale": `de` });
    expect(first.patches).toEqual([]);
});

test(`each account on one browser keeps its own file tree filters`, async () => {
    jest.useFakeTimers();
    const first = keeping();
    const one = await start(first, `account-1`);
    hideTests.value = true;
    await advanceTimersByTimeAsync(500);
    expect(Object.fromEntries(first.values)).toEqual({ "ui-workspace-hide-tests": `1` });
    one.value = null;

    // The next account in never chose to hide tests: it sees them, and its choice stays its own.
    const second = keeping();
    const two = await start(second, `account-2`);
    expect(hideTests.value).toBe(false);
    expect(second.writes).toBe(0);
    two.value = null;

    await start(first, `account-1`);
    expect(hideTests.value).toBe(true);
});

test(`a choice made signed out is nobody's, and the next account in takes it`, async () => {
    jest.useFakeTimers();
    const first = keeping({ "ui-locale": `pl`, "ui-agents-live-metrics": `off` });
    const one = await start(first, `account-1`);
    one.value = null;
    reloadAs(undefined);
    await realYield();

    // On the sign-in page, before anyone is in.
    textSize.value = `large`;
    await advanceTimersByTimeAsync(500);

    const second = keeping();
    await start(second, `account-2`);

    expect(textSize.value).toBe(`large`);
    expect(locale.value).toBe(`en`);
    expect(gauges.value).toBe(`system`);
    expect(second.patches).toEqual([{ "ui-text-size": `large` }]);
});

test(`a choice made here goes to the account with whatever was chosen beside it, a removal as null`, async () => {
    jest.useFakeTimers();
    const kept = keeping({ "ui-agents-live-metrics": `off` });
    await start(kept);

    // The Theme row's sanctum: the skin, and the scheme it drags dark.
    skin.value = `sanctum`;
    scheme.value = `dark`;
    gauges.value = `system`;
    audience.value = `maker`;
    await advanceTimersByTimeAsync(400);
    expect(kept.patches).toEqual([]);
    await advanceTimersByTimeAsync(100);

    expect(kept.patches).toEqual([{ "ui-skin": `sanctum`, "ui-color-scheme": `dark`, "ui-agents-live-metrics": null }]);
    expect(Object.fromEntries(kept.values)).toEqual({ "ui-skin": `sanctum`, "ui-color-scheme": `dark` });
});

test(`a choice made while the account is being read is not undone by the answer`, async () => {
    jest.useFakeTimers();
    const kept = keeping({ "ui-color-scheme": `light` });
    const answer = kept.holdReads();
    await start(kept);

    scheme.value = `dark`;
    answer();
    await realYield();
    expect(scheme.value).toBe(`dark`);

    await advanceTimersByTimeAsync(500);
    expect(kept.patches).toEqual([{ "ui-color-scheme": `dark` }]);
});

test(`a patch that fails leaves the choice standing, is said once, and goes up when the platform answers again`, async () => {
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    jest.useFakeTimers();
    const kept = keeping({ "ui-color-scheme": `light` });
    await start(kept);

    kept.refusal = new Error(`offline`);
    scheme.value = `dark`;
    await advanceTimersByTimeAsync(500);
    textSize.value = `large`;
    await advanceTimersByTimeAsync(500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(scheme.value).toBe(`dark`);

    // Back at the window a while later: what was waiting goes up before the account is read, so its older word undoes nothing.
    kept.refusal = undefined;
    await advanceTimersByTimeAsync(AFTER_A_WHILE);
    await comeBack();

    expect(kept.patches).toEqual([{ "ui-color-scheme": `dark`, "ui-text-size": `large` }]);
    expect(scheme.value).toBe(`dark`);
    expect(storedPreference(`ui-color-scheme`)).toBe(`dark`);
});

test(`coming back to the window reads the account again, at most every few minutes`, async () => {
    jest.useFakeTimers();
    const kept = keeping();
    await start(kept);

    // Chosen on another device meanwhile.
    kept.values.set(`ui-text-size`, `large`);
    await comeBack();
    expect(kept.reads).toBe(1);

    await advanceTimersByTimeAsync(AFTER_A_WHILE);
    await comeBack();

    expect(kept.reads).toBe(2);
    expect(textSize.value).toBe(`large`);
});

test(`signed out nothing is read or sent, and signing in reads the account, whose word wins`, async () => {
    jest.useFakeTimers();
    const kept = keeping({ "ui-text-size": `large` });
    const account = await start(kept, null);

    textSize.value = `default`;
    await advanceTimersByTimeAsync(500);
    expect([kept.reads, kept.writes]).toEqual([0, 0]);

    account.value = { id: `account-1` };
    await realYield();

    expect(kept.reads).toBe(1);
    expect(textSize.value).toBe(`large`);
});

test(`a window with no platform behind it reads and sends nothing, whoever it shows as signed in`, async () => {
    // The desktop app's own copy of the editor, for when the internet is out (environments/local.ts).
    window.__INTENTIC_SANDBOX_FACE__ = true;
    jest.useFakeTimers();
    const kept = keeping({ "ui-text-size": `large` });
    await start(kept);

    textSize.value = `default`;
    await advanceTimersByTimeAsync(500);

    expect([kept.reads, kept.writes]).toEqual([0, 0]);
});

test(`inside the Android app the look stays the app's: neither worn from the account nor given to it`, async () => {
    inApp = true;
    jest.useFakeTimers();
    localStorage.setItem(`ui-color-scheme`, `light`);
    localStorage.setItem(`ui-skin`, `silver`);
    localStorage.setItem(`ui-wallpaper`, `valley`);
    const kept = keeping({ "ui-color-scheme": `dark`, "ui-text-size": `large` });
    await start(kept);

    expect(storedPreference(`ui-color-scheme`)).toBe(`light`);
    expect(storedPreference(`ui-text-size`)).toBe(`large`);
    expect(kept.patches).toEqual([{ "ui-wallpaper": `valley` }]);

    scheme.value = `dark`;
    textSize.value = `default`;
    await advanceTimersByTimeAsync(500);

    expect(kept.patches.at(-1)).toEqual({ "ui-text-size": `default` });
});

test(`a platform from before account preferences is asked nothing more`, async () => {
    jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    jest.useFakeTimers();
    const kept = keeping();
    kept.refusal = new ORPCError(`NOT_FOUND`);
    await start(kept);

    textSize.value = `large`;
    await advanceTimersByTimeAsync(AFTER_A_WHILE);
    await comeBack();

    expect([kept.reads, kept.writes]).toEqual([1, 0]);
});

test(`every preference that follows the account is one the platform keeps`, async () => {
    const { ACCOUNT_PREFERENCE_KEYS } = await import(`./accountPreferenceKeys`);

    expect(ACCOUNT_PREFERENCE_KEYS.length).toBeLessThanOrEqual(ACCOUNT_PREFERENCES_MAX);
    expect(ACCOUNT_PREFERENCE_KEYS.filter((key) => !ACCOUNT_PREFERENCE_NAME.test(key))).toEqual([]);
});
