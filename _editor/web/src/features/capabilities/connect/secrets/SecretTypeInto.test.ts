// The owner's Type into…: it types on a computer whose keyring answers, the one holding a kept value first; it says when
// to have the cursor in place while the countdown runs; and it answers with where the value went, or the sentence the
// keyring refused it with. Nothing is typed until Type is pressed.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { computed, createApp, h, nextTick, ref } from "vue";
import type { SandboxKeyring, SecretInventoryEntry } from "@intentic/sandbox-contract/schemas/secrets";
import { type SecretRow, secretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";

type Typed = { program: string; field: `password` | `text`; asked: boolean };
let settle: { resolve: (value: Typed) => void; reject: (error: Error) => void } | undefined;
const typeInto = {
    mutateAsync: jest.fn(
        (_input: { key: string; device: string; countdownSeconds: number }) =>
            new Promise<Typed>((resolve, reject) => {
                settle = { resolve, reject };
            }),
    ),
};
const keyrings = ref<SandboxKeyring[]>([]);

jest.mock(`./useKeyrings`, () => ({
    useKeyrings: () => ({ keyrings, online: computed(() => keyrings.value.filter((keyring) => keyring.online)) }),
    useTypeInto: () => ({ typeInto }),
}));

const { default: SecretTypeInto } = await import("./SecretTypeInto.vue");

const rowWith = (entry: Partial<SecretInventoryEntry> = {}): SecretRow =>
    secretRow(
        { key: `VPN_PASSWORD`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true, ...entry },
        { capabilities: [], extensions: [] },
    );

const keyring = (machine: string, online = true): SandboxKeyring => ({ machine, online, locked: false, shared: 0 });

const mount = (row: SecretRow) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretTypeInto, { row }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const button = (label: string): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
        if (found === undefined) {
            throw new Error(`no "${label}" button`);
        }
        return found;
    };
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, button, done };
};

// Lets the awaited answer reach the template.
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

beforeEach(() => {
    typeInto.mutateAsync.mockClear();
    settle = undefined;
    keyrings.value = [keyring(`omen`), keyring(`rog`), keyring(`laptop`, false)];
});

it("types on the computer that holds a kept value, after the countdown, and says where it went", async () => {
    const { el, button, done } = mount(
        rowWith({ kind: `device`, revealable: false, device: { machine: `rog`, mode: `each-use`, online: true, locked: false, source: `keyring` } }),
    );
    // Only computers that answer are offered.
    expect([...el.querySelectorAll(`button[aria-pressed]`)].map((chip) => chip.textContent?.trim())).toEqual([`omen`, `rog`]);
    expect(el.querySelector(`button[aria-pressed="true"]`)?.textContent?.trim()).toBe(`rog`);
    expect(el.textContent).toContain(`Press Type, then put the cursor where it goes on rog. It is typed after 3 s.`);
    expect(typeInto.mutateAsync).not.toHaveBeenCalled();

    button(`Type`).click();
    await nextTick();
    expect(typeInto.mutateAsync).toHaveBeenCalledWith({ key: `VPN_PASSWORD`, device: `rog`, countdownSeconds: 3 });
    expect(el.textContent).toContain(`Typing on rog in 3 s. Put the cursor where it goes.`);

    settle?.resolve({ program: `FortiClient.exe`, field: `password`, asked: true });
    await settled();
    expect(el.textContent).toContain(`Typed into FortiClient.exe, password field. Confirmed on rog first.`);
    expect(button(`Type again`).disabled).toBe(false);
    done();
});

it("types on whichever computer is picked, with the wait chosen", async () => {
    const { el, button, done } = mount(rowWith());
    expect(el.querySelector(`button[aria-pressed="true"]`)?.textContent?.trim()).toBe(`omen`);
    button(`rog`).click();
    await nextTick();
    button(`10 s`).click();
    await nextTick();
    button(`Type`).click();
    await nextTick();
    expect(typeInto.mutateAsync).toHaveBeenCalledWith({ key: `VPN_PASSWORD`, device: `rog`, countdownSeconds: 10 });
    settle?.resolve({ program: `mstsc.exe`, field: `text`, asked: false });
    await settled();
    expect(el.textContent).toContain(`Typed into mstsc.exe, text field.`);
    expect(el.textContent).not.toContain(`Confirmed on`);
    done();
});

it("says the keyring's refusal in its own words", async () => {
    const { el, button, done } = mount(rowWith());
    button(`Type`).click();
    await nextTick();
    settle?.reject(new Error(`The focused window is notepad.exe, which is not on this secret's list.`));
    await settled();
    expect(el.textContent).toContain(`Could not type it on omen.`);
    expect(el.textContent).toContain(`The focused window is notepad.exe, which is not on this secret's list.`);
    done();
});

it("says there is nowhere to type when no computer with a keyring answers", () => {
    keyrings.value = [keyring(`laptop`, false)];
    const { el, done } = mount(rowWith());
    expect(el.textContent).toContain(`No computer with a keyring answers now.`);
    expect([...el.querySelectorAll(`button`)].some((candidate) => candidate.textContent?.trim() === `Type`)).toBe(false);
    done();
});
