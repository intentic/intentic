// A secret's host guard as its open row shows it: read as its answer ("Any host", or the hosts it goes to unasked), and
// changed in a panel hanging off that answer. Nothing is written until someone who runs secrets presses Save there; a
// host still in the box counts; turning it off keeps the hosts; a connector's own guard says whose it is; and anybody
// else reads the answer with nothing to press.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract/schemas/secrets";
import { type SecretRow, secretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";
import { SecretPopoverStub } from "./SecretPopover.testing";

const setHosts = {
    mutateAsync: jest.fn(async (input: { subject: string; kind: string; guard: boolean; hosts: string[] }) => ({ guard: input.guard, hosts: input.hosts })),
};
// Whether the reader runs secrets: the owner, Full access, or someone given Secrets.
const runsSecrets = ref(true);

jest.mock(`../../../../models/capabilities/useSecrets`, () => ({
    useCredentialGates: () => ({ runsSecrets }),
    useSecretHosts: () => ({ setHosts }),
}));
jest.mock(`./SecretPopover.vue`, () => ({ default: SecretPopoverStub }));

const { default: SecretHostsEditor } = await import("./SecretHostsEditor.vue");

// Built the way the Secrets view builds its rows, so the row carries exactly what the view would hand the editor.
const rowWith = (entry: Partial<SecretInventoryEntry> = {}): SecretRow =>
    secretRow(
        { key: `GITHUB_TOKEN`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true, ...entry },
        { capabilities: [], extensions: [] },
    );

// Lets a save's awaited answer reach the template.
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

const mount = (row: SecretRow) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretHostsEditor, { row }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const answer = (): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>(`button[aria-label^="Change where it may go"]`);
    const open = async (): Promise<void> => {
        const found = answer();
        if (found === null) {
            throw new Error(`no answer to press on the row`);
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
    const fill = async (text: string): Promise<HTMLInputElement> => {
        const input = el.querySelector<HTMLInputElement>(`input[type="text"]`);
        if (input === null) {
            throw new Error(`no host box in the panel`);
        }
        input.value = text;
        input.dispatchEvent(new Event(`input`));
        await nextTick();
        return input;
    };
    const add = async (text: string): Promise<void> => {
        const input = await fill(text);
        input.form?.dispatchEvent(new Event(`submit`, { cancelable: true }));
        await nextTick();
    };
    const button = (label: string): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
        if (found === undefined) {
            throw new Error(`no "${label}" button on the row`);
        }
        return found;
    };
    const chips = (): (string | undefined)[] => [...el.querySelectorAll(`.ui-chip`)].map((chip) => chip.textContent?.trim());
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, answer, open, choose, fill, add, button, chips, done };
};

beforeEach(() => {
    setHosts.mutateAsync.mockClear();
    runsSecrets.value = true;
});

it("reads as any host, and limits it to the hosts typed or pasted only when someone who runs secrets presses Save", async () => {
    const { el, open, choose, add, button, chips, done } = mount(rowWith());
    expect(el.textContent).toContain(`Goes to`);
    expect(el.textContent).toContain(`Any host`);
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    await open();
    await choose(`Only these hosts`);
    expect(el.textContent).toContain(`No host listed yet, so every use will ask.`);
    await add(`https://API.github.com/user`);
    await add(`*.githubusercontent.com`);
    expect(chips()).toEqual([`api.github.com`, `*.githubusercontent.com`]);
    expect(setHosts.mutateAsync).not.toHaveBeenCalled();
    button(`Save`).click();
    await settled();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({
        subject: `GITHUB_TOKEN`,
        kind: `secret`,
        guard: true,
        hosts: [`api.github.com`, `*.githubusercontent.com`],
    });
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    done();
});

it("counts a host still in the box when Save is pressed, rather than dropping what was typed", async () => {
    const { open, choose, fill, button, done } = mount(rowWith());
    await open();
    await choose(`Only these hosts`);
    await fill(`gitlab.lan`);
    button(`Save`).click();
    await settled();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `GITHUB_TOKEN`, kind: `secret`, guard: true, hosts: [`gitlab.lan`] });
    done();
});

it("says so when what was typed is not a host, adds nothing, and saves nothing", async () => {
    const { el, open, choose, add, button, chips, done } = mount(rowWith());
    await open();
    await choose(`Only these hosts`);
    await add(`*.com`);
    expect(el.textContent).toContain(`That is not a host. Write one like api.example.com, or *.example.com for every host under it.`);
    expect(chips()).toEqual([]);
    button(`Save`).click();
    await settled();
    expect(setHosts.mutateAsync).not.toHaveBeenCalled();
    expect(el.querySelector(`[data-popover]`)).not.toBeNull();
    done();
});

it("reads a connector's own guard as its hosts, says whose they are, and lets them go anywhere while keeping them", async () => {
    const { el, open, choose, button, chips, done } = mount(
        rowWith({ key: `github`, kind: `capability`, status: `connected`, hosts: { guard: true, list: [`api.github.com`, `github.com`], source: `connector` } }),
    );
    expect(el.textContent).toContain(`api.github.com, github.com`);
    expect(el.textContent).toContain(`Anywhere else asks first · set by its connector`);
    await open();
    expect(el.textContent).toContain(`Its connector's own hosts for its service.`);
    expect(chips()).toEqual([`api.github.com`, `github.com`]);
    await choose(`Any host`);
    button(`Save`).click();
    await settled();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `github`, kind: `capability`, guard: false, hosts: [`api.github.com`, `github.com`] });
    done();
});

it("limits a guard that is off to the hosts it kept, when turned back on", async () => {
    const { el, open, choose, button, chips, done } = mount(
        rowWith({ key: `github`, kind: `capability`, status: `connected`, hosts: { guard: false, list: [`api.github.com`], source: `owner` } }),
    );
    expect(el.textContent).toContain(`Any host`);
    await open();
    await choose(`Only these hosts`);
    expect(chips()).toEqual([`api.github.com`]);
    button(`Save`).click();
    await settled();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `github`, kind: `capability`, guard: true, hosts: [`api.github.com`] });
    done();
});

it("reads a guard with no host as every use asking", () => {
    const { el, done } = mount(rowWith({ hosts: { guard: true, list: [], source: `owner` } }));
    expect(el.textContent).toContain(`No host unasked`);
    expect(el.textContent).toContain(`Every use asks first`);
    done();
});

it("drops what Cancel was pressed on, and writes nothing", async () => {
    const { el, open, choose, add, button, chips, done } = mount(rowWith());
    await open();
    await choose(`Only these hosts`);
    await add(`api.github.com`);
    button(`Cancel`).click();
    await nextTick();
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    expect(setHosts.mutateAsync).not.toHaveBeenCalled();
    await open();
    expect(chips()).toEqual([]);
    expect(el.textContent).toContain(`Any host`);
    done();
});

it("shows anyone who does not run secrets the answer as it stands, with nothing to press", () => {
    runsSecrets.value = false;
    const { el, answer, done } = mount(rowWith({ hosts: { guard: true, list: [`api.github.com`], source: `owner` } }));
    expect(el.textContent).toContain(`api.github.com`);
    expect(el.textContent).toContain(`Anywhere else asks first`);
    expect(answer()).toBeNull();
    expect(el.querySelector(`input`)).toBeNull();
    done();
});
