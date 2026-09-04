// @vitest-environment jsdom
//
// THE APPROVAL EDITOR'S THREE STATES, pinned because the first one went missing in a way nobody could see: the
// "Needs approval" switch was bound to whether a gate was STORED, so flipping it on changed nothing it read, and
// the picker under it appeared only when the roster had somebody to pre-select. An owner on a fresh sandbox
// flipped the switch, watched nothing happen, and concluded the feature had no way to name anybody.
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import type { CredentialGate } from "@intentic/sandbox-contract";
import type { SecretRow } from "../pages/sandbox/secretRows";

const setGate = { mutateAsync: vi.fn(async () => undefined) };
const removeGate = { mutateAsync: vi.fn(async () => undefined) };
const approverChoices = ref<string[]>([]);
const isOwner = ref(true);
const stored = ref<CredentialGate | undefined>(undefined);

vi.mock(`vue-router`, () => ({ RouterLink: { template: `<a><slot /></a>` } }));
vi.mock(`../composables/secrets/useSecrets`, () => ({
    reveal: vi.fn(),
    useSecrets: () => ({ remove: { mutateAsync: vi.fn() } }),
    useCredentialGates: () => ({
        gates: ref([]),
        gateFor: (subject: string) => (stored.value?.subject === subject ? stored.value : undefined),
        approverChoices,
        isOwner,
        setGate,
        removeGate,
    }),
}));

const { default: SecretEntryRow } = await import("./SecretEntryRow.vue");

const ROW: SecretRow = {
    entry: { key: `DATABASE_URL`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true },
    group: `yours`,
    title: `DATABASE_URL`,
    mono: true,
    detail: ``,
    icon: `key`,
    attention: false,
    editable: true,
    removable: true,
    gateSubject: `DATABASE_URL`,
    sessionShaped: false,
    haystack: `database_url`,
};

const mount = () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretEntryRow, { row: ROW, expanded: true }) });
    app.use(PrimeVue);
    app.component(`Icon`, { props: [`name`], template: `<span />` });
    app.directive(`tooltip`, {});
    app.mount(el);
    const flip = async (): Promise<void> => {
        const input = el.querySelector<HTMLInputElement>(`input[role="switch"]`);
        if (input === null) {
            throw new Error(`no switch on the row`);
        }
        input.click();
        await nextTick();
    };
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, flip, done };
};

it("opens the picker when the owner flips the switch, with the owner already picked", async () => {
    approverChoices.value = [`owner@x.com`, `bob@x.com`];
    stored.value = undefined;
    const { el, flip, done } = mount();
    expect(el.innerHTML).toContain(`The agent can use this without asking anybody.`);
    expect(el.innerHTML).not.toContain(`Who can release it`);
    await flip();
    expect(el.innerHTML).toContain(`Who can release it`);
    expect(el.innerHTML).toContain(`bob@x.com`);
    // The switch itself reads as on: it speaks for the draft, not only for a stored gate.
    expect(el.querySelector(`input[role="switch"]`)?.getAttribute(`aria-checked`)).toBe(`true`);
    const owner = [...el.querySelectorAll<HTMLButtonElement>(`button[aria-pressed]`)].find((button) => button.textContent?.includes(`owner@x.com`));
    expect(owner?.getAttribute(`aria-pressed`)).toBe(`true`);
    // Nobody else on the roster yet is not this case: two names, no nudge toward the Access tab.
    expect(el.innerHTML).not.toContain(`Access tab`);
    done();
});

it("says where names come from when the owner is the only one, instead of a lone chip", async () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = undefined;
    const { el, flip, done } = mount();
    await flip();
    expect(el.innerHTML).toContain(`owner@x.com`);
    expect(el.innerHTML).toContain(`Only you so far.`);
    expect(el.innerHTML).toContain(`Access tab`);
    done();
});

it("still opens with nobody to name, and says so: the sentence that used to be unreachable", async () => {
    approverChoices.value = [];
    stored.value = undefined;
    const { el, flip, done } = mount();
    await flip();
    expect(el.innerHTML).toContain(`Nobody can be named yet.`);
    expect(el.innerHTML).toContain(`Access tab`);
    expect(el.innerHTML).toContain(`Name at least one person.`);
    // Flipping back off with only a draft is a change of mind, not a removal the daemon hears about.
    await flip();
    expect(el.innerHTML).toContain(`The agent can use this without asking anybody.`);
    expect(removeGate.mutateAsync).not.toHaveBeenCalled();
    done();
});

it("flipping off a stored gate asks the daemon to remove it", async () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `use` };
    const { el, flip, done } = mount();
    expect(el.querySelector(`input[role="switch"]`)?.getAttribute(`aria-checked`)).toBe(`true`);
    expect(el.innerHTML).toContain(`Who can release it`);
    await flip();
    expect(removeGate.mutateAsync).toHaveBeenCalledWith(`DATABASE_URL`);
    done();
});

it("renders the read-only sentence for everybody but the owner", () => {
    isOwner.value = false;
    approverChoices.value = [`owner@x.com`];
    stored.value = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `conversation` };
    const { el, done } = mount();
    expect(el.querySelector(`input[role="switch"]`)).toBeNull();
    expect(el.innerHTML).toContain(`Only owner@x.com can release this`);
    expect(el.innerHTML).toContain(`owner can change this.`);
    done();
    isOwner.value = true;
});
