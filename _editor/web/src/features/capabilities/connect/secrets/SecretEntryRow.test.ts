//
// AN OPEN SECRET, READ AS ANSWERS: its value, its last use and where it lives on one side, and when it asks first on the
// other (who releases it, where it may go, what it may be typed into), each as a word or two with nothing to fill in at
// rest. Every answer is where it is changed, in a panel hanging off it with its own Save. The approval panel's three
// states are pinned because the first one once went missing where nobody could see it: an owner on a fresh sandbox
// asked for a named approver, watched nothing happen, and concluded the feature had no way to name anybody.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { computed, createApp, h, nextTick, ref } from "vue";
import type { CredentialGate, SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";
import { SecretPopoverStub } from "./SecretPopover.testing";

const setGate = { mutateAsync: jest.fn(async () => undefined) };
const removeGate = { mutateAsync: jest.fn(async () => undefined) };
const approverChoices = ref<string[]>([]);
// Whether the reader runs secrets (the owner, Full access, or someone given Secrets), which is what reads a value out
// and changes a rule; and whether they read the roster (People and access), which is what lists everybody to name.
const runsSecrets = ref(true);
const namesEveryone = ref(true);
const stored = ref<CredentialGate | undefined>(undefined);

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
        namesEveryone,
        runsSecrets,
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

jest.mock(`./SecretPopover.vue`, () => ({ default: SecretPopoverStub }));

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
    mountedForTurn: false,
    typeable: true,
    programsHere: true,
    haystack: `database_url`,
};

const mount = (row: SecretRow = ROW, expanded = true) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const asked = jest.fn();
    const app = createApp({ render: () => h(SecretEntryRow, { row, expanded, "onUpdate:expanded": asked }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const press = async (selector: string): Promise<void> => {
        const found = el.querySelector<HTMLButtonElement>(selector);
        if (found === null) {
            throw new Error(`nothing on the row matches ${selector}`);
        }
        found.click();
        await nextTick();
    };
    const choose = async (title: string): Promise<void> => {
        const radio = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((candidate) => candidate.textContent?.includes(title));
        if (radio === undefined) {
            throw new Error(`no "${title}" choice in the panel`);
        }
        radio.click();
        await nextTick();
    };
    const button = (label: string): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
        if (found === undefined) {
            throw new Error(`no "${label}" button on the row`);
        }
        return found;
    };
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, asked, press, choose, button, done };
};

const APPROVAL = `button[aria-label^="Change who releases it"]`;

// Lets a save's awaited answer reach the template.
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

beforeEach(() => {
    setGate.mutateAsync.mockClear();
    removeGate.mutateAsync.mockClear();
    runsSecrets.value = true;
    namesEveryone.value = true;
    keyrings.value = [];
});

it("reads every rule as its answer, approver first, with nothing to fill in at rest", () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = undefined;
    const { el, done } = mount();
    const text = el.textContent ?? ``;
    expect(text.indexOf(`Approval`)).toBeLessThan(text.indexOf(`Goes to`));
    expect(text.indexOf(`Goes to`)).toBeLessThan(text.indexOf(`Typed into`));
    expect(text).toContain(`Not needed`);
    expect(text).toContain(`Any host`);
    expect(text).toContain(`Asks each time`);
    expect(text).toContain(`desired-state/.env`);
    // An answer, not a form: no switch, no box and no Save until one is pressed.
    expect(el.querySelectorAll(`input, textarea`)).toHaveLength(0);
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    done();
});

it("opens onto named people with the owner already picked, and saves them only on Save", async () => {
    approverChoices.value = [`owner@x.com`, `bob@x.com`];
    stored.value = undefined;
    const { el, press, choose, button, done } = mount();
    await press(APPROVAL);
    expect(el.innerHTML).not.toContain(`Who can release it`);
    await choose(`Named people`);
    expect(el.innerHTML).toContain(`Who can release it`);
    const owner = [...el.querySelectorAll<HTMLButtonElement>(`button[aria-pressed]`)].find((chip) => chip.textContent?.includes(`owner@x.com`));
    expect(owner?.getAttribute(`aria-pressed`)).toBe(`true`);
    // Two names on the roster: no nudge toward Access.
    expect(el.innerHTML).not.toContain(`Open Access`);
    expect(setGate.mutateAsync).not.toHaveBeenCalled();
    button(`Save`).click();
    await settled();
    expect(setGate.mutateAsync).toHaveBeenCalledWith({ subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `use` });
    done();
});

it("says where names come from when the owner is the only one, instead of a lone chip", async () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = undefined;
    const { el, press, choose, done } = mount();
    await press(APPROVAL);
    await choose(`Named people`);
    expect(el.innerHTML).toContain(`owner@x.com`);
    expect(el.innerHTML).toContain(`Only you so far`);
    expect(el.innerHTML).toContain(`Open Access`);
    done();
});

it("still opens with nobody to name, says so, and will not save an empty list", async () => {
    approverChoices.value = [];
    stored.value = undefined;
    const { el, press, choose, button, done } = mount();
    await press(APPROVAL);
    await choose(`Named people`);
    expect(el.innerHTML).toContain(`Nobody can be named yet`);
    expect(el.innerHTML).toContain(`Open Access`);
    expect(el.innerHTML).toContain(`Name at least one person.`);
    expect(button(`Save`).disabled).toBe(true);
    // Going back to nobody with nothing stored is a change of mind, not a removal the daemon hears about.
    await choose(`Not needed`);
    expect(button(`Save`).disabled).toBe(true);
    expect(removeGate.mutateAsync).not.toHaveBeenCalled();
    done();
});

it("reads a stored gate as its approvers, and asking nobody removes it", async () => {
    approverChoices.value = [`owner@x.com`];
    stored.value = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `use` };
    const { el, press, choose, button, done } = mount();
    expect(el.textContent).toContain(`owner@x.com`);
    expect(el.textContent).toContain(`Each use asks again`);
    await press(APPROVAL);
    await choose(`Not needed`);
    button(`Save`).click();
    await settled();
    expect(removeGate.mutateAsync).toHaveBeenCalledWith(`DATABASE_URL`);
    done();
});

// Somebody given Secrets below Full access reads no roster: the people to name are themselves and whoever a gate
// already names, so one can be taken off, and the panel says why nobody else is offered rather than sending them to
// Access, where they could not add anyone.
it("offers someone who runs secrets but not people themselves and the names already on a gate", async () => {
    namesEveryone.value = false;
    approverChoices.value = [`helper@x.com`, `owner@x.com`];
    stored.value = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `use` };
    const { el, press, button, done } = mount();
    await press(APPROVAL);
    const chips = [...el.querySelectorAll<HTMLButtonElement>(`button[aria-pressed]`)].filter((chip) => chip.textContent?.includes(`@`));
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([`helper@x.com`, `owner@x.com`]);
    expect(el.innerHTML).toContain(`Only you and the people already named`);
    expect(el.innerHTML).not.toContain(`Open Access`);
    // Untoggling the owner and naming oneself saves exactly that.
    chips[1]?.click();
    chips[0]?.click();
    await nextTick();
    button(`Save`).click();
    await settled();
    expect(setGate.mutateAsync).toHaveBeenCalledWith({ subject: `DATABASE_URL`, kind: `secret`, approvers: [`helper@x.com`], scope: `use` });
    done();
});

it("shows anyone who does not run secrets the same answers, with nothing to press", () => {
    runsSecrets.value = false;
    approverChoices.value = [`owner@x.com`];
    stored.value = { subject: `DATABASE_URL`, kind: `secret`, approvers: [`owner@x.com`], scope: `conversation` };
    const { el, done } = mount();
    expect(el.querySelector(APPROVAL)).toBeNull();
    expect(el.textContent).toContain(`owner@x.com`);
    expect(el.textContent).toContain(`One release covers a conversation`);
    expect(el.textContent).toContain(`The owner, Full access, or someone given Secrets changes these.`);
    expect(el.querySelector(`button[aria-label^="Change where it may go"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label^="Change what it may be typed into"]`)).toBeNull();
    done();
});

// The daemon reveals a value to whoever runs secrets (secrets.routes.ts `mayReveal`): the owner, Full access, or someone
// given Secrets. The button used to say "owner only" to the maintainer it worked for, and stood pressable for a
// collaborator it refused.
const revealButton = (el: HTMLElement): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>(`button[aria-label^="Reveal value"]`);

it("lets someone who runs secrets reveal a value beside it, and names who may", () => {
    const { el, done } = mount();
    expect(revealButton(el)?.disabled).toBe(false);
    expect(revealButton(el)?.getAttribute(`aria-label`)).toBe(`Reveal value (whoever manages Secrets)`);
    expect(el.textContent).not.toContain(`changes these`);
    done();
});

it("keeps the value shut for someone who does not run secrets, whom the daemon would refuse, and says who may see it", () => {
    runsSecrets.value = false;
    const open = mount();
    expect(revealButton(open.el)).toBeNull();
    expect(open.el.textContent).toContain(`Only the owner, Full access, or someone given Secrets can see it`);
    open.done();
    const closed = mount(ROW, false);
    expect(revealButton(closed.el)?.disabled).toBe(true);
    closed.done();
});

// A gated value is read out to its approvers alone, whoever else runs secrets; the inventory says so as `revealable`.
it("says a gated value is its approvers' to see, for someone who runs secrets but is not one", () => {
    const gated = { subject: `DATABASE_URL`, kind: `secret` as const, approvers: [`owner@x.com`], scope: `use` as const };
    stored.value = gated;
    const { el, done } = mount({ ...ROW, entry: { ...ROW.entry, revealable: false, gate: { approvers: gated.approvers, scope: gated.scope } } });
    expect(revealButton(el)).toBeNull();
    expect(el.textContent).toContain(`Only its approvers can see it`);
    done();
});

it("offers its value's shortcuts on a closed row, and opens the row onto the one pressed", async () => {
    const closed = mount(ROW, false);
    await closed.press(`button[aria-label="Set / update value"]`);
    expect(closed.asked).toHaveBeenCalledWith(true);
    closed.done();
    // Open, each sits labelled beside the value it acts on, so the header keeps only Remove.
    const open = mount();
    expect(open.el.querySelector(`button[aria-label="Set / update value"]`)).toBeNull();
    expect(open.el.querySelector(`button[aria-label="Remove"]`)).not.toBeNull();
    expect(open.el.querySelector(`button[aria-label="Replace value"]`)).not.toBeNull();
    open.done();
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
    mountedForTurn: false,
    typeable: true,
    programsHere: false,
    haystack: `vpn_password`,
};

const ROG: SandboxKeyring = { machine: `rog`, online: true, locked: false, shared: 1 };

it("offers nothing that reads, copies or sets a value kept on one of the owner's computers", () => {
    const { el, done } = mount(DEVICE_ROW);
    expect(revealButton(el)).toBeNull();
    expect(el.querySelector(`button[aria-label="Replace value"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label="Remove"]`)).toBeNull();
    expect(el.textContent).toContain(`Stays on rog, never here`);
    expect(el.textContent).toContain(`This sandbox holds only a pointer to it`);
    done();
});

it("reads a keyring entry's share and rules, and names the command that changes them on that computer", () => {
    const { el, done } = mount(DEVICE_ROW);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Asks each time`);
    expect(text).toContain(`rog is unlocked now`);
    expect(text).toContain(`FortiClient.exe`);
    expect(text).toContain(`Password fields only`);
    expect(text).toContain(`vpn.example.com`);
    expect(text).toContain(`Run this on rog`);
    expect(el.querySelector(`[data-keyring-command]`)?.textContent).toBe(`intentic-machine keyring edit VPN_PASSWORD`);
    // Its lists are the keyring's, changed there: the only answer to press is the sandbox's own approver.
    expect(el.querySelector(`button[aria-label^="Change where it may go"]`)).toBeNull();
    expect(el.querySelector(`button[aria-label^="Change what it may be typed into"]`)).toBeNull();
    expect(el.querySelector(APPROVAL)).not.toBeNull();
    done();
});

it("says when and where it was last used, and what a command or window it went to was", () => {
    const { el, done } = mount(DEVICE_ROW);
    expect(el.textContent).toContain(`typed on rog · FortiClient.exe`);
    done();
    const desktop = mount({ ...ROW, entry: { ...ROW.entry, lastUse: { at: Date.now() - 60_000, lane: `desktop`, detail: `xfce4-terminal` } } });
    expect(desktop.el.textContent).toContain(`typed on the sandbox's desktop`);
    expect(desktop.el.querySelector(`code`)?.textContent).toBe(`xfce4-terminal`);
    desktop.done();
});

it("offers Type into… only where a computer has a keyring, and opens it beside the value", async () => {
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
});
