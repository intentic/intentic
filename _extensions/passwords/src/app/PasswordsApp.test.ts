import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import type { KeyringNeedAnswer } from "@intentic/sandbox-contract/schemas/keyring";
import type { PasswordItem, PasswordRequest, PasswordsCapabilities, PasswordsPort, VaultStatus } from "./port.js";

// The Passwords app against a fake port: a computer with no vault is taken through turning it on, its recovery key,
// the one yes to remembering and the import; a request is answered with the password that fits, or a value typed once
// when none does; and the sandbox's view offers nothing that manages the vault.

// The kit's device readout asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

// Vue's DOM renderer takes the document it will draw into when it is first evaluated, so it is loaded once the DOM is.
await import("@intentic/testing/bun-vue");
const { createApp, h, nextTick } = await import("vue");
const { default: PrimeVue } = await import("primevue/config");
const { Icon } = await import("@intentic/extension-ui");
const { registerExtensionMessages } = await import("@intentic/extension-ui/i18n");
const { messages, PASSWORDS_EXTENSION_ID } = await import("../i18n.js");
await registerExtensionMessages(PASSWORDS_EXTENSION_ID, messages);
const { default: PasswordsApp } = await import("./PasswordsApp.vue");

const READY: VaultStatus = {
    kind: `ready`,
    locked: false,
    unlockedUntil: Date.now() + 600_000,
    unlock: [`hello`],
    pendingCaptures: 0,
    remember: { browser: true, terminal: true, apps: false, phone: false, sandbox: false },
    rememberAsked: true,
    computer: `rog`,
};
const SANDBOX = { url: `https://intentic-dev.intentic.app`, label: `intentic-dev` };
const GITHUB: PasswordItem = {
    name: `GITHUB_COM`,
    title: `github.com`,
    kind: `password`,
    category: `site`,
    username: `radarsu`,
    origins: [{ kind: `site`, host: `github.com` }],
    captured: { source: `browser`, via: `Brave`, at: Date.now() - 3_600_000 },
    fresh: false,
    unverified: false,
    createdAt: 1,
    updatedAt: 1,
    versions: 0,
    anyField: false,
    access: [{ sandbox: SANDBOX, level: `ask`, since: 1 }],
};
const NEED: PasswordRequest = {
    id: `need-1`,
    sandbox: SANDBOX,
    origin: { kind: `site`, host: `github.com` },
    username: `radarsu`,
    detail: `push the release branch`,
    at: Date.now() - 120_000,
    matches: [`GITHUB_COM`],
};

interface Calls {
    setUp: { hello: boolean }[];
    remember: unknown[];
    sources: string[];
    answers: { id: string; answer: KeyringNeedAnswer; options?: { name?: string; value?: string } }[];
}

const fakePort = (options: { status: VaultStatus; items?: PasswordItem[]; requests?: PasswordRequest[]; capabilities?: PasswordsCapabilities }) => {
    const calls: Calls = { setUp: [], remember: [], sources: [], answers: [] };
    let status = options.status;
    let requests = options.requests ?? [];
    const settings = { remember: { browser: true, terminal: true, apps: false, phone: false, sandbox: false }, neverSave: [], autoLockMinutes: 15, lockOnSleep: true };
    const port: PasswordsPort = {
        capabilities: options.capabilities ?? { scope: `computer`, manage: true, reveal: true },
        status: async () => status,
        list: async () => options.items ?? [],
        sandboxes: async () => [SANDBOX],
        setUp: async (asked) => {
            calls.setUp.push(asked);
            status = READY;
            return { recoveryKey: `ABCD-EFGH-IJKL-MNOP` };
        },
        unlock: async () => undefined,
        lock: async () => undefined,
        reveal: async () => ({ value: `hunter2` }),
        copy: async () => ({ clearsAt: Date.now() + 30_000 }),
        add: async () => ({ name: `NEW` }),
        edit: async () => undefined,
        remove: async () => undefined,
        setAccess: async () => undefined,
        history: async () => [],
        restore: async () => undefined,
        undo: async () => undefined,
        seen: async () => undefined,
        requests: async () => requests,
        answer: async (id, answer, given) => {
            calls.answers.push(given === undefined ? { id, answer } : { id, answer, options: given });
            requests = requests.filter((request) => request.id !== id);
        },
        activity: async () => [],
        settings: async () => settings,
        updateSettings: async (patch) => {
            calls.remember.push(patch.remember);
            return settings;
        },
        sources: async () => [
            { source: `browser`, on: false, ready: false, available: true, detail: `Brave`, asks: `Brave will ask once` },
            { source: `terminal`, on: false, ready: true, available: true },
            { source: `phone`, on: false, ready: false, available: false, why: `No phone is paired.` },
        ],
        setUpSource: async (source) => {
            calls.sources.push(source);
        },
        importRows: async () => ({ saved: 0, updated: 0, unchanged: 0, skipped: 0 }),
        manageOnComputer: () => undefined,
    };
    return { port, calls };
};

let unmount: (() => void) | undefined;
afterEach(() => unmount?.());

const mount = (port: PasswordsPort, selection: { filter?: string; item?: string } = {}): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(PasswordsApp, { port, selection }) });
    app.use(PrimeVue);
    // What the editor installs app-wide and the kit's PrimeVue controls draw with: its icons, and a tooltip that is no
    // business of these tests.
    app.component(`Icon`, Icon);
    app.directive(`tooltip`, {});
    app.mount(el);
    unmount = () => {
        app.unmount();
        el.remove();
    };
    return el;
};

const button = (el: HTMLElement, text: string): HTMLButtonElement => {
    const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim().includes(text) === true);
    if (found === undefined) {
        throw new Error(`no button "${text}" in: ${el.textContent ?? ``}`);
    }
    return found;
};

describe(`PasswordsApp`, () => {
    it(`turns Passwords on, shows the recovery key once, and asks once to remember`, async () => {
        const { port, calls } = fakePort({ status: { kind: `not-set-up`, canSetUp: true, hello: true, computer: `rog` } });
        const el = mount(port);
        await waitFor(() => expect(el.textContent).toContain(`Your passwords stay on this computer`));
        expect(el.textContent).not.toMatch(/hardened|keyring|askpass|inbox/iu);

        button(el, `Turn on Passwords`).click();
        await waitFor(() => expect(el.textContent).toContain(`ABCD-EFGH-IJKL-MNOP`));
        expect(calls.setUp).toEqual([{ hello: true }]);
        // Continue waits for the reader to say the key is kept.
        expect(button(el, `Continue`).disabled).toBe(true);
        const kept = el.querySelector<HTMLInputElement>(`input[type="checkbox"]`);
        kept?.click();
        await nextTick();
        await waitFor(() => expect(button(el, `Continue`).disabled).toBe(false));
        button(el, `Continue`).click();

        await waitFor(() => expect(el.textContent).toContain(`Let Intentic remember the passwords you type`));
        expect(el.textContent).not.toContain(`ABCD-EFGH-IJKL-MNOP`);
        expect(el.textContent).toContain(`Brave will ask once`);
        button(el, `Turn on`).click();
        await waitFor(() => expect(el.textContent).toContain(`Bring your passwords along`));
        // Every source this computer can have, on together; only the one not yet in place is set up.
        expect(calls.remember).toEqual([{ browser: true, terminal: true }]);
        expect(calls.sources).toEqual([`browser`]);

        button(el, `Done`).click();
        // The app itself: its title, and the list (empty here) where the first run was.
        await waitFor(() => expect(el.textContent).toContain(`No passwords yet.`));
    });

    it(`says why it cannot be turned on where it cannot`, async () => {
        const { port } = fakePort({ status: { kind: `not-set-up`, canSetUp: false, why: `Passwords needs administrator approval once.`, hello: false, computer: `rog` } });
        const el = mount(port);
        await waitFor(() => expect(el.textContent).toContain(`Passwords needs administrator approval once.`));
        expect(button(el, `Turn on Passwords`).disabled).toBe(true);
    });

    it(`answers a request with the password that fits`, async () => {
        const { port, calls } = fakePort({ status: READY, items: [GITHUB], requests: [NEED] });
        const el = mount(port, { filter: `requests` });
        await waitFor(() => expect(el.textContent).toContain(`intentic-dev's agent wants to sign in to github.com as radarsu`));
        expect(el.textContent).toContain(`to push the release branch`);
        button(el, `While I'm here`).click();
        await waitFor(() => expect(calls.answers).toEqual([{ id: `need-1`, answer: `while-here`, options: { name: `GITHUB_COM` } }]));
        await waitFor(() => expect(el.textContent).toContain(`No agent is waiting for a password.`));
    });

    it(`offers to type it once when nothing fits, and sends the value with the yes`, async () => {
        const { port, calls } = fakePort({ status: READY, items: [], requests: [{ ...NEED, matches: [] }] });
        const el = mount(port, { filter: `requests` });
        await waitFor(() => expect(el.textContent).toContain(`No saved password fits`));
        expect(button(el, `Save & allow`).disabled).toBe(true);
        const field = el.querySelector<HTMLInputElement>(`input[type="password"]`);
        if (field === null) {
            throw new Error(`no field`);
        }
        field.value = `s3cret`;
        field.dispatchEvent(new Event(`input`));
        await waitFor(() => expect(button(el, `Save & allow`).disabled).toBe(false));
        button(el, `Save & allow`).click();
        await waitFor(() => expect(calls.answers).toEqual([{ id: `need-1`, answer: `once`, options: { value: `s3cret` } }]));
    });

    it(`offers nothing that manages the vault in a sandbox's view`, async () => {
        const { port } = fakePort({ status: READY, items: [GITHUB], capabilities: { scope: `sandbox`, manage: false, reveal: false } });
        const el = mount(port, { item: `GITHUB_COM` });
        await waitFor(() => expect(el.textContent).toContain(`saved from Brave`));
        expect(el.querySelector(`[aria-label="New password"]`)).toBeNull();
        expect(el.querySelector(`[aria-label="Settings"]`)).toBeNull();
        expect(el.textContent).not.toContain(`Delete password`);
        expect(el.textContent).not.toContain(`Edit`);
        expect(el.textContent).toContain(`Manage on this computer`);
        // The access is read, not set.
        expect(el.querySelector(`[role="tablist"]`)).toBeNull();
        expect(el.textContent).toContain(`Ask`);
    });

    it(`lists a password with where it came from, and opens it`, async () => {
        const { port } = fakePort({ status: READY, items: [GITHUB] });
        const el = mount(port, { item: `GITHUB_COM` });
        await waitFor(() => expect(el.textContent).toContain(`radarsu · saved from Brave`));
        expect(el.textContent).toContain(`{{secret:GITHUB_COM}}`);
        expect(el.querySelector(`[role="option"][aria-selected="true"]`)?.textContent).toContain(`github.com`);
        button(el, `Show`).click();
        await waitFor(() => expect(el.textContent).toContain(`hunter2`));
    });
});
