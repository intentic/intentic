import type { LocalFace } from "@intentic/web/local";
import { ACCOUNT_POINTER_KEY, resetAccountPartitionForTests, storedValue } from "@intentic/ui/storage";
import { seedFolderSession, seedFolderWindow } from "./folderSession";

// What a folder window's boot leaves for the editor: the session its sandbox client opens the folder with, and the folder
// as the sandbox it opens on, both where the editor reads them, whichever account the browser is signed in to.

const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47148`, token: `window-bearer`, id: `f3a9c2`, name: `brief.docx`, path: `/home/ada/Documents`, file: `brief.docx` };
const SANDBOX = `local-f3a9c2`;

// The browser's storage as a page has it: plain names, nothing scoped.
const memoryStorage = (): Storage => {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value)),
    };
};

let local: Storage;
const realLocal = Object.getOwnPropertyDescriptor(globalThis, `localStorage`);
const realSession = Object.getOwnPropertyDescriptor(globalThis, `sessionStorage`);

beforeEach(() => {
    local = memoryStorage();
    Object.defineProperty(globalThis, `localStorage`, { value: local, configurable: true });
    Object.defineProperty(globalThis, `sessionStorage`, { value: memoryStorage(), configurable: true });
    resetAccountPartitionForTests();
});

afterAll(() => {
    for (const [name, descriptor] of [
        [`localStorage`, realLocal],
        [`sessionStorage`, realSession],
    ] as const) {
        if (descriptor === undefined) {
            Reflect.deleteProperty(globalThis, name);
        } else {
            Object.defineProperty(globalThis, name, descriptor);
        }
    }
    resetAccountPartitionForTests();
});

// The session as the editor's sandbox client reads it (client/session/sandboxSession.ts), or null where it finds none.
interface SeededSession {
    readonly token: string;
    readonly expiresAt: number;
    readonly email: string;
}
// SAFETY: written by seedFolderSession above as exactly this shape; a test reading something else fails its toEqual.
const sessionRead = (): SeededSession | null => JSON.parse(storedValue(`intentic.session.${SANDBOX}`) ?? `null`) as SeededSession | null;

describe(`a folder window's session`, () => {
    it(`lands in the signed-in account's drawer, where the editor reads it`, () => {
        // The app's other pages on this origin signed the browser in to an account (the editor's accountBoundary.ts).
        local.setItem(ACCOUNT_POINTER_KEY, `machine:ann@example.com`);
        seedFolderWindow(FACE);

        expect(sessionRead()).toEqual({ token: `window-bearer`, expiresAt: expect.any(Number), email: expect.any(String) });
        expect(storedValue(`intentic.activeSandboxId`)).toBe(SANDBOX);
        expect(local.getItem(`intentic@machine%3Aann%40example.com/intentic.session.${SANDBOX}`)).not.toBeNull();
        // Under its own name it would be nobody's: the editor never reads it there while a drawer is open.
        expect(local.getItem(`intentic.session.${SANDBOX}`)).toBeNull();
        expect(local.getItem(`intentic.activeSandboxId`)).toBeNull();
    });

    it(`is stored under its own name while nobody is signed in`, () => {
        seedFolderWindow(FACE);

        expect(local.getItem(`intentic.session.${SANDBOX}`)).not.toBeNull();
        expect(sessionRead()).toEqual(expect.objectContaining({ token: `window-bearer` }));
        expect(storedValue(`intentic.activeSandboxId`)).toBe(SANDBOX);
    });

    it(`declines the loopback offer on the device, whoever is signed in`, () => {
        local.setItem(ACCOUNT_POINTER_KEY, `machine:ann@example.com`);
        expect(seedFolderSession(FACE)).toBe(SANDBOX);
        expect(local.getItem(`intentic.localShortcut.declined.${SANDBOX}`)).toBe(`yes`);
    });
});
