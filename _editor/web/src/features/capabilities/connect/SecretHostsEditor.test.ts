// A secret's host guard, as the owner edits it on the secret's row: turning it on writes only on the owner's say, with
// each host as typed or pasted; turning it off saves at once and keeps the hosts; a connector's own guard says whose it
// is and turns off and back on with its hosts; and anybody but the owner reads it as it stands.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { type SecretRow, secretRow } from "../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";

const setHosts = {
    mutateAsync: jest.fn(async (input: { subject: string; kind: string; guard: boolean; hosts: string[] }) => ({ guard: input.guard, hosts: input.hosts })),
};
const isOwner = ref(true);

jest.mock(`./useSecrets`, () => ({
    useCredentialGates: () => ({ isOwner }),
    useSecretHosts: () => ({ setHosts }),
}));

const { default: SecretHostsEditor } = await import("./SecretHostsEditor.vue");

// Built the way the Secrets view builds its rows, so the row carries exactly what the view would hand the editor.
const rowWith = (entry: Partial<SecretInventoryEntry> = {}): SecretRow =>
    secretRow(
        { key: `GITHUB_TOKEN`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true, ...entry },
        { capabilities: [], extensions: [] },
    );

const mount = (row: SecretRow) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretHostsEditor, { row, expanded: true }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const flip = async (): Promise<void> => {
        el.querySelector<HTMLInputElement>(`input[role="switch"]`)?.click();
        await nextTick();
    };
    const type = async (text: string): Promise<void> => {
        const input = el.querySelector<HTMLInputElement>(`input[type="text"]`);
        if (input === null) {
            throw new Error(`no host box on the row`);
        }
        input.value = text;
        input.dispatchEvent(new Event(`input`));
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
    return { el, flip, type, button, chips, done };
};

beforeEach(() => {
    setHosts.mutateAsync.mockClear();
    isOwner.value = true;
});

it("turns the guard on only when the owner says so, with each host as typed or pasted", async () => {
    const { el, flip, type, button, chips, done } = mount(rowWith());
    expect(el.textContent).toContain(`Off: it is never held for where it goes, and the safety judge alone decides.`);
    await flip();
    expect(el.textContent).toContain(`No host is listed, so every use asks.`);
    await type(`https://API.github.com/user`);
    await type(`*.githubusercontent.com`);
    expect(chips()).toEqual([`api.github.com`, `*.githubusercontent.com`]);
    expect(setHosts.mutateAsync).not.toHaveBeenCalled();
    button(`Turn on`).click();
    await nextTick();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({
        subject: `GITHUB_TOKEN`,
        kind: `secret`,
        guard: true,
        hosts: [`api.github.com`, `*.githubusercontent.com`],
    });
    done();
});

it("turns the guard on with no hosts, where every use asks", async () => {
    const { flip, button, done } = mount(rowWith());
    await flip();
    button(`Turn on`).click();
    await nextTick();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `GITHUB_TOKEN`, kind: `secret`, guard: true, hosts: [] });
    done();
});

it("says so when what was typed is not a host, and adds nothing", async () => {
    const { el, flip, type, chips, done } = mount(rowWith());
    await flip();
    await type(`*.com`);
    expect(el.textContent).toContain(`That is not a host. Write one like api.example.com, or *.example.com for every host under it.`);
    expect(chips()).toEqual([]);
    done();
});

it("names a connector's own guard as the connector's, and turns it off at once, keeping its hosts", async () => {
    const { el, flip, chips, done } = mount(
        rowWith({ key: `github`, kind: `capability`, status: `connected`, hosts: { guard: true, list: [`api.github.com`, `github.com`], source: `connector` } }),
    );
    expect(el.textContent).toContain(`Its connector's own hosts for its service.`);
    expect(chips()).toEqual([`api.github.com`, `github.com`]);
    await flip();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `github`, kind: `capability`, guard: false, hosts: [`api.github.com`, `github.com`] });
    done();
});

it("turns a guard that is off back on with the hosts it kept", async () => {
    const { el, flip, button, chips, done } = mount(
        rowWith({ key: `github`, kind: `capability`, status: `connected`, hosts: { guard: false, list: [`api.github.com`], source: `owner` } }),
    );
    expect(el.textContent).toContain(`Turned back on, it goes unasked to api.github.com again.`);
    await flip();
    expect(chips()).toEqual([`api.github.com`]);
    button(`Turn on`).click();
    await nextTick();
    expect(setHosts.mutateAsync).toHaveBeenCalledWith({ subject: `github`, kind: `capability`, guard: true, hosts: [`api.github.com`] });
    done();
});

it("shows anybody but the owner the guard as it stands, with no controls", async () => {
    isOwner.value = false;
    const on = mount(rowWith({ hosts: { guard: true, list: [`api.github.com`], source: `owner` } }));
    expect(on.el.textContent).toContain(`On: it goes unasked only to api.github.com, and anywhere else asks first. Only the owner can change that.`);
    expect(on.el.querySelector(`input`)).toBeNull();
    on.done();
    const off = mount(rowWith({ hosts: { guard: false, list: [`api.github.com`], source: `owner` } }));
    expect(off.el.textContent).toContain(`Off: it is never held for where it goes. Only the owner can change that.`);
    off.done();
});
