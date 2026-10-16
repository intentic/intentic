import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { KeyringEntry, KeyringStatus } from "../../desktop";

// This device's Passwords group, against Tauri's own IPC mock standing in for keyring.rs: a computer with no keyring is
// offered the setup, which sends the passphrase once, only when both match, and clears it from the page at the press; a
// set-up one says whether it is locked and unlocks; a password is added with its value as the call's own argument and
// shared straight after when a sandbox is picked; the keyring's refusal is said in its words; and while a prompt is up on
// this computer the group says to confirm there.

// The kit's device readout asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

// Vue's DOM renderer takes the document it will draw into when it is first evaluated, so everything that reaches it is
// loaded only now, once the DOM above is in place: this package's test runs preload no DOM of their own, and no `.vue`
// compiler either, so the editor's is registered first for the component this file mounts.
await import("@intentic/testing/bun-vue");
const { createApp, h, nextTick } = await import("vue");
const { default: PrimeVue } = await import("primevue/config");
const { IconStub } = await import("@intentic/ui/testing");
const { registerDesktopCatalog } = await import("../../i18n");
await registerDesktopCatalog();
const { default: PasswordsGroup } = await import("./PasswordsGroup.vue");

const NOT_SET_UP: KeyringStatus = { installed: true, running: true, setUp: false, askpass: { installed: false } };
const KEYS = { seal: `A`.repeat(43), inbox: `B`.repeat(43) };
const LOCKED: KeyringStatus = {
    installed: true,
    running: true,
    setUp: true,
    state: { version: `1.0.0`, locked: true, unlock: [`hello`, `passphrase`], keys: KEYS, pendingInbox: 2 },
    askpass: { installed: false },
};
const VPN: KeyringEntry = {
    name: `VPN_PASSWORD`,
    kind: `password`,
    programs: [`FortiClient.exe`],
    packages: [],
    hosts: [],
    anyField: false,
    askpass: [],
    source: `keyring`,
    shares: [{ sandbox: `https://ann.intentic.dev`, machine: `rog`, mode: `each-use`, sharedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
};

// What each keyring command answers: its JSON line, nothing (no agent), or a line still to come.
interface Answer {
    readonly line?: string | null;
    readonly later?: () => Promise<string>;
}
let answers = new Map<string, Answer>();
const answer = (command: string, line: string | null): void => void answers.set(command, { line });
let calls: { command: string; args: Record<string, unknown> }[] = [];
const ok = (rest: object = {}): string => JSON.stringify({ ok: true, ...rest });

beforeEach(() => {
    calls = [];
    answers = new Map();
    answer(`keyring_status`, ok(NOT_SET_UP));
    answer(`keyring_list`, ok({ entries: [], backends: [] }));
    mockIPC((command, args) => {
        // SAFETY: every command here is invoked with a plain object of arguments, or none.
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        const answered = answers.get(command);
        if (answered === undefined) {
            throw new Error(`no answer for ${command}`);
        }
        return answered.later === undefined ? (answered.line ?? null) : answered.later();
    });
});
afterEach(() => clearMocks());

const mount = (props: { windows?: boolean; links?: { sandboxUrl: string; id: string }[] } = {}) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(PasswordsGroup, props) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const text = (): string => el.textContent ?? ``;
    const button = (label: string): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
        if (found === undefined) {
            throw new Error(`no "${label}" button in: ${text()}`);
        }
        return found;
    };
    const type = async (input: HTMLInputElement | null, value: string): Promise<void> => {
        if (input === null) {
            throw new Error(`no such field`);
        }
        input.value = value;
        input.dispatchEvent(new Event(`input`));
        await nextTick();
    };
    const field = (label: string): HTMLInputElement | null => el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, text, button, type, field, done };
};

const sent = (command: string) => calls.filter((call) => call.command === command);

it("sets up a vault only with the passphrase given twice, and takes it out of the page at the press", async () => {
    const { text, button, type, field, done } = mount({ windows: true });
    await waitFor(() => expect(text()).toContain(`Keep passwords on this computer`));
    button(`Set up`).click();
    await nextTick();
    await type(field(`Recovery passphrase`), `correct horse`);
    await type(field(`The same passphrase again`), `correct hors`);
    expect(text()).toContain(`The two passphrases differ.`);
    expect(button(`Set up`).disabled).toBe(true);
    await type(field(`The same passphrase again`), `correct horse`);

    let finish: ((line: string) => void) | undefined;
    answers.set(`keyring_setup`, { later: () => new Promise((resolve) => (finish = resolve)) });
    button(`Set up`).click();
    await waitFor(() => expect(sent(`keyring_setup`)).toHaveLength(1));
    expect(sent(`keyring_setup`)[0]?.args).toEqual({ passphrase: `correct horse`, hello: true });
    expect(field(`Recovery passphrase`)?.value).toBe(``);
    expect(field(`The same passphrase again`)?.value).toBe(``);
    await waitFor(() => expect(text()).toContain(`Confirm on this computer.`));

    answer(`keyring_status`, ok(LOCKED));
    finish?.(ok());
    await waitFor(() => expect(text()).toContain(`Locked`));
    expect(text()).not.toContain(`Confirm on this computer.`);
    done();
});

it("says a set-up keyring is locked, what waits for it, and unlocks it", async () => {
    answer(`keyring_status`, ok(LOCKED));
    answer(`keyring_list`, ok({ entries: [VPN], backends: [] }));
    answer(`keyring_unlock`, ok());
    const { text, button, done } = mount();
    await waitFor(() => expect(text()).toContain(`VPN_PASSWORD`));
    expect(text()).toContain(`Values sent from a sandbox wait for the next unlock: 2.`);
    expect(text()).toContain(`Password · into FortiClient.exe — ann.intentic.dev: asks each time`);
    button(`Unlock`).click();
    await waitFor(() => expect(sent(`keyring_unlock`)).toHaveLength(1));
    expect(sent(`keyring_unlock`)[0]?.args).toEqual({ minutes: null });
    done();
});

it("adds a password with its value as the call's own argument, then shares it with the sandbox picked", async () => {
    answer(`keyring_status`, ok({ ...LOCKED, state: { ...LOCKED.state, locked: false } }));
    answer(`keyring_add`, ok());
    answer(`keyring_share`, ok());
    const { el, text, button, type, field, done } = mount({ links: [{ sandboxUrl: `https://ann.intentic.dev`, id: `link-1` }] });
    await waitFor(() => expect(text()).toContain(`Nothing kept here yet.`));
    button(`Add password`).click();
    await nextTick();
    await type(field(`Name, like VPN_PASSWORD`), `VPN_PASSWORD`);
    await type(el.querySelector<HTMLInputElement>(`input[data-value]`), `hunter2`);
    await type(field(`Programs`), `FortiClient.exe, mstsc.exe`);
    button(`ann.intentic.dev`).click();
    await nextTick();
    button(`While I'm at the computer`).click();
    await nextTick();
    button(`Add`).click();
    await waitFor(() => expect(sent(`keyring_share`)).toHaveLength(1));
    expect(sent(`keyring_add`)[0]?.args).toEqual({
        entry: { name: `VPN_PASSWORD`, kind: `password`, programs: [`FortiClient.exe`, `mstsc.exe`], packages: [], hosts: [], anyField: false },
        value: `hunter2`,
    });
    expect(sent(`keyring_share`)[0]?.args).toEqual({ name: `VPN_PASSWORD`, sandbox: `https://ann.intentic.dev`, mode: `while-here` });
    done();
});

it("says the keyring's refusal in its own words, and keeps the value out of the page", async () => {
    answer(`keyring_status`, ok({ ...LOCKED, state: { ...LOCKED.state, locked: false } }));
    answer(`keyring_add`, JSON.stringify({ ok: false, code: `declined`, refusal: `You said no on this computer, so nothing was kept.` }));
    const { el, text, button, type, field, done } = mount();
    await waitFor(() => expect(text()).toContain(`Add password`));
    button(`Add password`).click();
    await nextTick();
    await type(field(`Name, like VPN_PASSWORD`), `VPN_PASSWORD`);
    await type(el.querySelector<HTMLInputElement>(`input[data-value]`), `hunter2`);
    button(`Add`).click();
    await waitFor(() => expect(text()).toContain(`You said no on this computer, so nothing was kept.`));
    expect(el.querySelector<HTMLInputElement>(`input[data-value]`)?.value).toBe(``);
    expect(sent(`keyring_share`)).toHaveLength(0);
    done();
});

it("says an agent older than its keyring needs updating, and draws nothing on a computer with no agent", async () => {
    answer(`keyring_status`, JSON.stringify({ ok: false, code: `agent-too-old`, refusal: `This computer's Intentic agent has no keyring yet. Update the agent, then try again.` }));
    const old = mount();
    await waitFor(() => expect(old.text()).toContain(`has no keyring yet`));
    expect(old.text()).not.toContain(`Set up`);
    old.done();

    answer(`keyring_status`, null);
    const none = mount();
    await waitFor(() => expect(none.el.querySelector(`[data-passwords]`)).toBeNull());
    none.done();
});
