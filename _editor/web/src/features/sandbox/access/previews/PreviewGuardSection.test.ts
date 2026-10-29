// The Previews group on the Access tab's Sign-in part: who may open this sandbox's previews, the choice of whoever runs
// people and access, what everyone else reads of it, and that a daemon older than the guard draws no group at all.
import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { type PreviewGuard, PreviewGuardSchema } from "@intentic/sandbox-contract/schemas/ports";
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import type { z } from "zod";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// Import chain touches a media query (UI barrel's useDevice) at module eval; hence jsdom.

const guard = ref<PreviewGuard>({ scope: `off` });
const readGuard = jest.fn(async (): Promise<PreviewGuard> => guard.value);
// Takes what the client sends (the scope may be left to its default) and answers as the daemon does, with the state after.
const setGuard = jest.fn(async (input: z.input<typeof PreviewGuardSchema>): Promise<PreviewGuard> => {
    guard.value = PreviewGuardSchema.parse(input);
    return guard.value;
});
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({ ports: { previewGuard: () => readGuard(), setPreviewGuard: (input: z.input<typeof PreviewGuardSchema>) => setGuard(input) } }),
}));
const role = ref<`owner` | `maintainer` | `writer`>(`owner`);
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: computed(() => ({ id: `s1`, name: `work`, role: role.value })), activeSandboxId: ref(`s1`), reachable: ref(true) }),
}));

const { default: PreviewGuardSection } = await import("./PreviewGuardSection.vue");
const { setDaemonRoutes } = await import("../../../../client/sandbox/useDaemonRoutes");
const { forgetOperations } = await import("../../../../workbench/operations/operations");
const { queryClient } = await import("../../../../lib/queryPersistence");
// A read that fails is shown at once rather than after the retries a browser would give it.
queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });

let app: App | undefined;
const mount = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(PreviewGuardSection) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};
const shown = (): string => document.body.textContent ?? ``;
const picker = (): HTMLButtonElement | null => document.body.querySelector(`button[aria-haspopup="listbox"]`);
// The picker's panel points at its trigger, and closes on one with no size, which is every element jsdom lays out; so
// the trigger is given the size a browser would.
const openPicker = async (): Promise<void> => {
    const trigger = picker();
    if (trigger !== null) {
        trigger.getBoundingClientRect = () => new DOMRect(0, 0, 288, 32);
        trigger.click();
    }
    await settle();
};
const option = (label: string): HTMLElement | undefined =>
    [...document.body.querySelectorAll<HTMLElement>(`[role="option"]`)].find((row) => row.textContent?.includes(label) === true);

afterEach(() => {
    guard.value = { scope: `off` };
    readGuard.mockClear();
    setGuard.mockClear();
    role.value = `owner`;
    setDaemonRoutes(undefined);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    forgetOperations();
});

it(`gives the owner the three choices, and keeps what they pick as the daemon answered it`, async () => {
    await mount();
    await waitFor(() => expect(picker()?.textContent).toContain(`Anyone with the address`));
    expect(shown()).toContain(`The outbox stays public.`);

    await openPicker();
    expect(option(`Members only: app previews and forwarded ports`)).not.toBeUndefined();
    option(`Members only: app previews`)?.click();
    await settle();

    expect(setGuard).toHaveBeenCalledWith({ scope: `panels` });
    await waitFor(() => expect(picker()?.textContent).toContain(`Members only: app previews`));
    // The answer is put where the read keeps it: nothing is read again to learn what was just said.
    expect(readGuard).toHaveBeenCalledTimes(1);
});

it(`says in the daemon's words why a change was refused, and keeps the choice as it stood`, async () => {
    setGuard.mockImplementationOnce(async () => {
        throw new SandboxHttpError(403, `Only the owner can do that.`);
    });
    await mount();
    await waitFor(() => expect(picker()).not.toBeNull());

    await openPicker();
    option(`Members only: app previews`)?.click();
    await settle();

    await waitFor(() => expect(shown()).toContain(`Couldn't change who can open previews.`));
    expect(shown()).toContain(`Only the owner can do that.`);
    expect(picker()?.textContent).toContain(`Anyone with the address`);
});

it(`shows everyone else where it stands and who can change it, with nothing to press`, async () => {
    role.value = `writer`;
    guard.value = { scope: `all` };
    await mount();

    await waitFor(() => expect(shown()).toContain(`Members only: app previews and forwarded ports`));
    expect(shown()).toContain(`The owner, Full access, or someone given People and access changes who can open previews.`);
    expect(picker()).toBeNull();
});

// Who may open a preview is who gets in, so Full access changes it as it changes everything else.
it(`gives Full access the choices too`, async () => {
    role.value = `maintainer`;
    await mount();

    await waitFor(() => expect(picker()?.textContent).toContain(`Anyone with the address`));
    expect(shown()).not.toContain(`changes who can open previews`);
});

// Unread, the guard could be on or off: drawn from nothing it would read "Anyone with the address" about a sandbox that may
// keep its previews to members.
it(`says the guard could not be read, and draws no choice, rather than showing previews as open`, async () => {
    readGuard.mockImplementationOnce(async () => {
        throw new SandboxHttpError(500, `The access store is unreadable.`);
    });
    await mount();

    await waitFor(() => expect(shown()).toContain(`Couldn't read who can open this sandbox's previews.`));
    expect(shown()).toContain(`The access store is unreadable.`);
    expect(picker()).toBeNull();
    expect(shown()).not.toContain(`Anyone with the address`);
});

it(`draws nothing, and asks nothing, of a daemon older than the guard`, async () => {
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => !name.startsWith(`ports.preview`)));
    await mount();

    expect(document.body.querySelector(`[data-setting="access-previews"]`)).toBeNull();
    expect(readGuard).not.toHaveBeenCalled();
});
