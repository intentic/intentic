// Mounts the Extension tile and pins a version by typing only a repository URL. The commit sha is the one thing an
// install must have and the one thing nobody can recall, so this is the affordance worth holding still: the form asks
// the remote, and a repository it cannot read still leaves a box to paste into.
import "@intentic/testing/dom";
import type { AddCapabilityInput } from "@intentic/capability-catalog";
import { type RemoteRefs, VAULTED } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import * as actualVueRouter from "vue-router";

let query: Record<string, string> = {};
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ params: { entry: `extension` }, query }) as never,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), resolve: (to: string) => ({ href: to }) }) as never,
}));

const add = jest.fn<(input: AddCapabilityInput) => Promise<void>>(async () => {});
const readRemoteRefs = jest.fn<(url: string, token?: string, keeping?: string) => Promise<RemoteRefs>>();
const capabilities = ref<{ id: string; kind: string; status: { state: string }; config: Record<string, string>; secrets: string[] }[]>([]);
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
    readRemoteRefs: (url: string, token?: string, keeping?: string) => readRemoteRefs(url, token, keeping),
}));
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
jest.mock(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Capabilities } = await import("./Capabilities.vue");

const HEAD = `a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`;
const RELEASE = `0f1e2d3c4b5a69788796a5b4c3d2e1f098765432`;
const OLD = `9999999999999999999999999999999999999999`;

const OFFERED: RemoteRefs = {
    defaultBranch: `main`,
    refs: [
        { name: `main`, kind: `branch`, sha: HEAD },
        { name: `next`, kind: `branch`, sha: OLD },
        { name: `v1.4.0`, kind: `tag`, sha: RELEASE },
    ],
};

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

// `secrets` is how the daemon says a credential is stored but withheld: the form has a token it was never shown.
const start = (editing?: { id: string; ref: string; url: string; secrets?: string[] }): HTMLElement => {
    query = editing === undefined ? {} : { edit: editing.id };
    capabilities.value =
        editing === undefined
            ? []
            : [
                  {
                      id: editing.id,
                      kind: `extension`,
                      status: { state: `active` },
                      config: { url: editing.url, ref: editing.ref },
                      secrets: editing.secrets ?? [],
                  },
              ];
    add.mockClear();
    readRemoteRefs.mockReset();
    readRemoteRefs.mockResolvedValue(OFFERED);
    return mount();
};

const boxFor = (el: HTMLElement, label: string): HTMLInputElement =>
    [...el.querySelectorAll(`label`)].find((row) => row.textContent?.includes(label))!.querySelector(`input`)!;

const versionRow = (el: HTMLElement): HTMLElement => [...el.querySelectorAll(`label`)].find((row) => row.textContent?.includes(`Version`))!;

const typeUrl = async (el: HTMLElement, url: string): Promise<void> => {
    const box = boxFor(el, `Git URL`);
    box.value = url;
    box.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
};

// The field settles before it asks, so a URL is one read rather than one per keystroke; every wait here is for that.
const settled = async (): Promise<void> => {
    await waitFor(() => expect(readRemoteRefs).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await waitFor(() => expect(versionRow(document.body).querySelector(`button`)).not.toBeNull(), { timeout: 3_000 });
};

const submitForm = async (el: HTMLElement): Promise<void> => {
    el.querySelector(`form`)!.dispatchEvent(new Event(`submit`, { bubbles: true, cancelable: true }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await nextTick();
};

it(`asks the repository what it offers and pins the default branch's commit, with nothing typed but the URL`, async () => {
    const el = start();

    // Before a URL there is nothing to resolve, so the field says where the answer comes from rather than demanding one.
    expect(versionRow(el).textContent).toContain(`Add the repository above`);

    await typeUrl(el, `https://github.com/owner/extension`);
    await settled();

    expect(readRemoteRefs).toHaveBeenCalledWith(`https://github.com/owner/extension`, undefined, undefined);
    // The picker shows the version, the summary shows the commit it resolved to: the reader sees both halves.
    expect(versionRow(el).textContent).toContain(`main`);
    expect(versionRow(el).textContent).toContain(HEAD.slice(0, 7));

    await submitForm(el);
    // What is stored is still the full commit, which is the whole point: the pin did not become a branch name.
    expect(add.mock.calls[0]?.[0].config).toMatchObject({ url: `https://github.com/owner/extension`, ref: HEAD });
});

it(`waits for the URL to settle, so typing one is a single read`, async () => {
    const el = start();

    await typeUrl(el, `https://github.com/owner/e`);
    await typeUrl(el, `https://github.com/owner/ext`);
    await typeUrl(el, `https://github.com/owner/extension`);
    await settled();

    expect(readRemoteRefs).toHaveBeenCalledTimes(1);
    expect(readRemoteRefs).toHaveBeenCalledWith(`https://github.com/owner/extension`, undefined, undefined);
});

it(`sends the token with the read, so a private repository answers on the form instead of at install time`, async () => {
    const el = start();

    await typeUrl(el, `https://github.com/owner/private`);
    const token = boxFor(el, `Access token`);
    token.value = `ghp_secret`;
    token.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
    await waitFor(() => expect(readRemoteRefs).toHaveBeenCalledWith(`https://github.com/owner/private`, `ghp_secret`, undefined), { timeout: 3_000 });
});

it(`a repository it cannot read is not a dead end: the reason shows and the box comes back`, async () => {
    const el = start();
    readRemoteRefs.mockRejectedValue(new Error(`Could not read it: that repository is private: add an access token with read access.`));

    await typeUrl(el, `https://github.com/owner/secret`);
    await waitFor(() => expect(versionRow(el).textContent).toContain(`add an access token`), { timeout: 3_000 });

    // Still typeable: pasting a sha by hand remains the escape hatch, and submitting it still works.
    const box = versionRow(el).querySelector(`input`)!;
    box.value = RELEASE;
    box.dispatchEvent(new Event(`input`, { bubbles: true }));
    await nextTick();
    await submitForm(el);
    expect(add.mock.calls[0]?.[0].config).toMatchObject({ ref: RELEASE });
});

it(`opening an install pinned to a commit the repository no longer names keeps that commit`, async () => {
    const el = start({ id: `ext`, ref: OLD, url: `https://github.com/owner/extension` });
    await waitFor(() => expect(readRemoteRefs).toHaveBeenCalledWith(`https://github.com/owner/extension`, undefined, `ext`), { timeout: 3_000 });
    await nextTick();

    // `next` happens to sit on that commit here, so the picker names it rather than pretending it is unknown.
    await waitFor(() => expect(versionRow(el).textContent).toContain(`next`), { timeout: 3_000 });

    await submitForm(el);
    expect(add.mock.calls[0]?.[0].config).toMatchObject({ ref: OLD });
});

// Otherwise editing a private repo's install would be the one case the picker can never answer: the form holds the
// token's marker, never the token.
it(`editing a private install keeps its stored token, sending the marker and the connection to resolve it against`, async () => {
    start({ id: `ext`, ref: OLD, url: `https://github.com/owner/private`, secrets: [`token`] });

    await waitFor(() => expect(readRemoteRefs).toHaveBeenCalledWith(`https://github.com/owner/private`, VAULTED, `ext`), { timeout: 3_000 });
});
