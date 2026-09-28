// Mounts the SSH tile and connects a machine with nobody handling a private key: the sandbox makes the pair, the form
// shows the public half and the one command that authorizes it, and what it sends is a marker naming the key the
// sandbox kept, never a key. Pasting your own key and signing in with a password still work beside it.
import "@intentic/testing/dom";
import type { AddCapabilityInput } from "@intentic/capability-catalog";
import { type SshKey, stashedMarker, VAULTED } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import * as actualVueRouter from "vue-router";

let query: Record<string, string> = {};
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the page reads only `params.entry` and `query` off the route; a member it reached past these would be undefined, failing the case.
    useRoute: () => ({ params: { entry: `ssh` }, query }) as never,
    // SAFETY: the page only moves between tiles with push/replace and builds links with resolve; nothing else is called.
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), resolve: (to: string) => ({ href: to }) }) as never,
}));

const add = jest.fn<(input: AddCapabilityInput) => Promise<void>>(async () => {});
const generateSshKey = jest.fn<() => Promise<SshKey>>();
const capabilities = ref<{ id: string; kind: string; status: { state: string }; config: Record<string, string | number>; secrets: string[] }[]>([]);
jest.mock(`./connect/useCapabilities`, () => ({
    useCapabilities: () => ({
        recommendationFor: () => undefined,
        capabilities,
        error: ref(undefined),
        add: (input: AddCapabilityInput) => add(input),
        remove: { mutateAsync: jest.fn(), isPending: ref(false) },
        rename: { mutateAsync: jest.fn(), isPending: ref(false) },
        refetch: jest.fn(),
        dismissRecommendation: { mutateAsync: jest.fn(), isPending: ref(false) },
    }),
    browseMarketplace: jest.fn(),
    probeCapability: jest.fn(),
    readRemoteRefs: jest.fn(async () => ({ refs: [] })),
}));
jest.mock(`./ssh/generateSshKey`, () => ({ generateSshKey: () => generateSshKey() }));
jest.mock(`../extensions/useExtensions`, () => ({
    useExtensions: () => ({ contributionOf: () => undefined, enabled: ref([]), extensions: ref([]), settled: ref(true) }),
}));
jest.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
jest.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: jest.fn(), stop: jest.fn() }),
    viewProcessLogs: jest.fn(),
}));
jest.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: jest.fn(), refresh: jest.fn(), start: jest.fn(), stop: jest.fn() }),
}));
jest.mock(`../sandbox/devices/useLiveLinks`, () => ({
    importForticlient: jest.fn(),
    useLiveLinks: () => ({ links: ref([]), error: ref(undefined), open: jest.fn(), close: jest.fn() }),
}));
jest.mock(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`./connect/hosts/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Capabilities } = await import("./Capabilities.vue");

const PUBLIC = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTvguxSytEi7TywcezOzMNcrdb4VPOz4TuDP/ezdzI8 intentic-box`;
const AUTHORIZE = `mkdir -p ~/.ssh && echo '${PUBLIC}' >> ~/.ssh/authorized_keys`;
const TOKEN = `one-time-token`;

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: String },
            setup:
                (props, { slots }) =>
                () =>
                    h(`a`, { href: props.to }, slots["default"]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// An edit opens over a connection the daemon echoed: its settings, the public half of its key, and which credentials it
// holds but never shows.
const start = (editing?: { id: string; config: Record<string, string | number>; secrets: string[] }): HTMLElement => {
    query = editing === undefined ? {} : { edit: editing.id };
    capabilities.value = editing === undefined ? [] : [{ kind: `ssh`, status: { state: `active` }, ...editing }];
    add.mockClear();
    generateSshKey.mockReset();
    generateSshKey.mockResolvedValue({ publicKey: PUBLIC, token: TOKEN });
    return mount();
};

const type = async (box: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
    box.value = value;
    box.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
};
const boxFor = (el: HTMLElement, label: string): HTMLInputElement =>
    [...el.querySelectorAll(`label`)].find((row) => row.textContent?.startsWith(label))!.querySelector(`input`)!;
const buttonNamed = (el: HTMLElement, name: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === name);
// A sign-in choice, by what it says: a labelled tab carries no aria-label of its own.
const authTab = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`[role="tab"]`)].find((tab) => tab.textContent?.trim() === label);
const pickAuth = async (el: HTMLElement, label: string): Promise<void> => {
    authTab(el, label)!.click();
    await nextTick();
};
const fillMachine = async (el: HTMLElement): Promise<void> => {
    await type(boxFor(el, `Host`), `box.example.com`);
    await type(boxFor(el, `User`), `deploy`);
};
const submitForm = (el: HTMLElement): void => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
};
const submitted = async (el: HTMLElement): Promise<AddCapabilityInput | undefined> => {
    submitForm(el);
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    return add.mock.calls[0]?.[0];
};

it(`generates the key in the sandbox by default, shows the public half and the command, and sends only a marker`, async () => {
    const el = start();
    // Nothing to paste: the tile opens on the generator, not on a box for a private key.
    expect(authTab(el, `Generate a key for me`)?.getAttribute(`aria-selected`)).toBe(`true`);
    expect(el.querySelector(`textarea`)).toBeNull();

    await fillMachine(el);
    buttonNamed(el, `Generate a key`)!.click();
    await waitFor(() => expect(el.textContent).toContain(AUTHORIZE));

    expect(generateSshKey).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain(`Public key`);
    // Whose authorized_keys it goes in: the user the connection signs in as.
    expect(el.textContent).toContain(`Authorize it: run this on the server, signed in as deploy`);

    const input = await submitted(el);
    expect(input?.kind).toBe(`ssh`);
    expect(input?.config).toEqual({ host: `box.example.com`, port: `22`, user: `deploy`, auth: `generated`, privateKey: stashedMarker(TOKEN) });
});

it(`refuses to save before a key exists, and says to generate one`, async () => {
    const el = start();
    await fillMachine(el);
    submitForm(el);
    await waitFor(() => expect(el.textContent).toContain(`Generate a key, and authorize it on the server, before saving.`));
    expect(add).not.toHaveBeenCalled();
});

it(`still takes a private key pasted by hand`, async () => {
    const el = start();
    await fillMachine(el);
    await pickAuth(el, `Paste my own key`);
    await type(el.querySelector(`textarea`)!, `-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----\n`);

    const input = await submitted(el);
    expect(input?.config).toEqual({
        host: `box.example.com`,
        port: `22`,
        user: `deploy`,
        auth: `key`,
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----`,
    });
    expect(generateSshKey).not.toHaveBeenCalled();
});

it(`still signs in with a password`, async () => {
    const el = start();
    await fillMachine(el);
    await pickAuth(el, `Password`);
    await type(boxFor(el, `Password`), `s3cret`);

    const input = await submitted(el);
    expect(input?.config).toEqual({ host: `box.example.com`, port: `22`, user: `deploy`, auth: `password`, password: `s3cret` });
});

// Both answer the same key: a marker left behind would show up in the paste box as text, and would be sent as a key.
it(`switching to a pasted key after generating one leaves the box empty, and coming back asks for a fresh key`, async () => {
    const el = start();
    await fillMachine(el);
    buttonNamed(el, `Generate a key`)!.click();
    await waitFor(() => expect(el.textContent).toContain(PUBLIC));

    await pickAuth(el, `Paste my own key`);
    expect(el.querySelector(`textarea`)?.value).toBe(``);

    await pickAuth(el, `Generate a key for me`);
    expect(el.textContent).not.toContain(PUBLIC);
    expect(buttonNamed(el, `Generate a key`)).toBeInstanceOf(HTMLButtonElement);
});

it(`editing a generated connection shows its public key again, and saving keeps the key it holds`, async () => {
    const el = start({
        id: `box`,
        config: { host: `box.example.com`, port: 22, user: `deploy`, auth: `generated`, publicKey: PUBLIC },
        secrets: [`privateKey`],
    });
    await waitFor(() => expect(el.textContent).toContain(AUTHORIZE));
    expect(buttonNamed(el, `Generate a new key`)).toBeInstanceOf(HTMLButtonElement);

    const input = await submitted(el);
    expect(input?.config).toEqual({ host: `box.example.com`, port: `22`, user: `deploy`, auth: `generated`, privateKey: VAULTED });
    expect(generateSshKey).not.toHaveBeenCalled();
});

it(`a key the sandbox could not make says why, and leaves the button to try again`, async () => {
    const el = start();
    generateSshKey.mockRejectedValue(new Error(`the sandbox is restarting`));
    buttonNamed(el, `Generate a key`)!.click();
    await waitFor(() => expect(el.textContent).toContain(`the sandbox is restarting`));
    expect(buttonNamed(el, `Generate a key`)).toBeInstanceOf(HTMLButtonElement);
});
