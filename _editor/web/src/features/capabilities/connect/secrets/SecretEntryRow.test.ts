//
// THE APPROVAL EDITOR'S THREE STATES, pinned because the first one went missing in a way nobody could see: the
// "Needs approval" switch was bound to whether a gate was STORED, so flipping it on changed nothing it read, and
// the picker under it appeared only when the roster had somebody to pre-select. An owner on a fresh sandbox
// flipped the switch, watched nothing happen, and concluded the feature had no way to name anybody.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { computed, createApp, h, nextTick, ref } from "vue";
import type { CredentialGate, SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";

const setGate = { mutateAsync: jest.fn(async () => undefined) };
const removeGate = { mutateAsync: jest.fn(async () => undefined) };
const approverChoices = ref<string[]>([]);
const isOwner = ref(true);
const stored = ref<CredentialGate | undefined>(undefined);
// The reader's tier, which the daemon reads a value out to from maintainer up.
const role = ref<`owner` | `maintainer` | `collaborator`>(`owner`);

jest.mock(`vue-router`, () => ({ RouterLink: { template: `<a><slot /></a>` } }));
jest.mock(`../../../../models/capabilities/useSecrets`, () => ({
    reveal: jest.fn(),
    useSecrets: () => ({ remove: { mutateAsync: jest.fn() } }),
    useSecretHosts: () => ({ setHosts: { mutateAsync: jest.fn() } }),
    useSecretPrograms: () => ({ programsFor: () => undefined, setPrograms: { mutateAsync: jest.fn() } }),
    useCredentialPolicy: () => ({ setPolicy: { mutateAsync: jest.fn() } }),
    useCredentialGates: () => ({
        gates: ref([]),
        gateFor: (subject: string) => (stored.value?.subject === subject ? stored.value : undefined),
        approverChoices,
        isOwner,
        setGate,
        removeGate,
    }),
}));

// The keyrings this sandbox reaches: none unless a case gives it some, which is a sandbox with no Type into… at all.
const keyrings = ref<SandboxKeyring[]>([]);
jest.mock(`./useKeyrings`, () => ({
    useKeyrings: () => ({ keyrings, online: computed(() => keyrings.value.filter((keyring) => keyring.online)) }),
    useTypeInto: () => ({ typeInto: { mutateAsync: jest.fn() } }),
}));

jest.mock(`../../../../client/sandbox/useRole`, () => ({
    useRole: () => ({ canShip: computed(() => role.value !== `collaborator`) }),
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
    typeable: true,
    programsHere: true,
    haystack: `database_url`,
};

const mount = (row: SecretRow = ROW) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretEntryRow, { row, expanded: true }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
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
    expect(el.innerHTML).toContain(`No named person has to release it.`);
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
    expect(el.innerHTML).toContain(`No named person has to release it.`);
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

// Who must release it, where it may go and which windows it may be typed into are one section to the owner, not three
// features: every switch sits under the one "Needs approval" heading, the approver first.
it("puts the host and program guards under the same approval heading as the named approver", () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = undefined;
    const { el, done } = mount();
    const text = el.textContent ?? ``;
    expect(text.indexOf(`Needs approval`)).toBeLessThan(text.indexOf(`From a named person`));
    expect(text.indexOf(`From a named person`)).toBeLessThan(text.indexOf(`Host guard`));
    expect(text.indexOf(`Host guard`)).toBeLessThan(text.indexOf(`Program guard`));
    expect([...el.querySelectorAll(`input[role="switch"]`)].map((input) => input.getAttribute(`aria-label`))).toEqual([
        `From a named person`,
        `Host guard`,
        `Any field`,
    ]);
    expect(text).toContain(`Off: it is never held for where it goes, and the safety judge alone decides.`);
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

// The daemon reveals a value from the maintainer tier up (secrets.routes.ts `reveal`). The button used to say "owner
// only" to the maintainer it worked for, and stood pressable for a collaborator it refused.
const revealButton = (el: HTMLElement): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>(`button[aria-label^="Reveal value"]`);

it("lets a maintainer reveal a value, and names who may", () => {
    role.value = `maintainer`;
    const { el, done } = mount();
    expect(revealButton(el)?.disabled).toBe(false);
    expect(revealButton(el)?.getAttribute(`aria-label`)).toBe(`Reveal value (owner and maintainers only)`);
    done();
    role.value = `owner`;
});

it("keeps Reveal shut for a collaborator, whom the daemon would refuse", () => {
    role.value = `collaborator`;
    const { el, done } = mount();
    expect(revealButton(el)?.disabled).toBe(true);
    done();
    role.value = `owner`;
});

// A KEYRING'S OWN ENTRY, kept on one of the owner's computers: this sandbox holds a pointer, so its row offers nothing
// that would read, copy or set a value, and its rules are the keyring's, read here with the command that changes them.
const DEVICE_ROW: SecretRow = {
    entry: {
        key: `VPN_PASSWORD`,
        kind: `device`,
        status: `set`,
        requiredBy: [],
        storedAt: `the keyring on rog`,
        revealable: false,
        device: { machine: `rog`, mode: `each-use`, online: true, locked: false, source: `keyring` },
        programs: { programs: [`FortiClient.exe`], packages: [], anyField: false, source: `keyring` },
        hosts: { guard: true, list: [`vpn.example.com`], source: `owner` },
        lastUse: { at: Date.now() - 60_000, lane: `device`, detail: `rog · FortiClient.exe` },
    },
    group: `device`,
    title: `VPN_PASSWORD`,
    mono: true,
    detail: `rog · asks each time`,
    icon: `desktop`,
    attention: false,
    editable: false,
    removable: false,
    gateSubject: `VPN_PASSWORD`,
    sessionShaped: false,
    typeable: true,
    programsHere: false,
    haystack: `vpn_password`,
};

const ROG: SandboxKeyring = { machine: `rog`, online: true, locked: false, shared: 1 };

it("offers nothing that reads, copies or sets a value kept on one of the owner's computers", () => {
    const { el, done } = mount(DEVICE_ROW);
    expect(revealButton(el)).toBeNull();
    expect(el.querySelector(`button[aria-label="Set / update value"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="Remove"]`)).toBeNull();
    expect(el.textContent).not.toContain(`Copy value`);
    done();
});

it("reads a keyring entry's share and rules, and names the command that changes them on that computer", () => {
    const { el, done } = mount(DEVICE_ROW);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Kept in the keyring on rog, shared here: asks each time.`);
    expect(text).toContain(`rog is unlocked now.`);
    expect(text).toContain(`Typed unasked only into FortiClient.exe. Only into a password field.`);
    expect(text).toContain(`Sites it may go to: vpn.example.com.`);
    expect(text).toContain(`Change these on rog:`);
    expect(el.querySelector(`[data-device-panel] code`)?.textContent).toBe(`intentic-machine keyring edit VPN_PASSWORD`);
    // Its lists are the keyring's: no editor for either, only the sandbox's own named approver.
    expect(text).not.toContain(`Host guard`);
    expect(text).not.toContain(`Program guard`);
    expect([...el.querySelectorAll(`input[role="switch"]`)].map((input) => input.getAttribute(`aria-label`))).toEqual([`From a named person`]);
    done();
});

it("says where a value kept on a computer was last typed", () => {
    const { el, done } = mount(DEVICE_ROW);
    expect(el.textContent).toContain(`typed on rog · FortiClient.exe`);
    done();
    const desktop = mount({ ...ROW, entry: { ...ROW.entry, lastUse: { at: Date.now() - 60_000, lane: `desktop`, detail: `xfce4-terminal` } } });
    expect(desktop.el.textContent).toContain(`typed on the sandbox's desktop xfce4-terminal`);
    desktop.done();
});

it("offers Type into… only where a computer has a keyring, and opens it in the row", async () => {
    keyrings.value = [];
    const none = mount();
    expect(none.el.querySelector(`button[aria-label="Type into…"]`)).toBeNull();
    none.done();

    keyrings.value = [ROG];
    const { el, done } = mount(DEVICE_ROW);
    const button = el.querySelector<HTMLButtonElement>(`button[aria-label="Type into…"]`);
    expect(button).not.toBeNull();
    button?.click();
    await nextTick();
    expect(el.querySelector(`section[aria-label="Type into…"]`)).not.toBeNull();
    expect(el.textContent).toContain(`Press Type, then put the cursor where it goes on rog. It is typed after 3 s.`);
    done();
    keyrings.value = [];
});
