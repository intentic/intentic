// A sandbox-held secret's program guard, as the owner edits it on the secret's row: programs and Android apps are added
// as typed and saved together with "any field" only on the owner's say; what is not a program or a package is said and
// not added; and anybody but the owner reads the list as it stands.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import type { SecretInventoryEntry, SecretProgramGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { type SecretRow, secretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";

const setPrograms = {
    mutateAsync: jest.fn(async (input: SecretProgramGuard) => ({ programs: input.programs, packages: input.packages, anyField: input.anyField })),
};
const isOwner = ref(true);
const guards = ref<SecretProgramGuard[]>([]);

jest.mock(`../../../../models/capabilities/useSecrets`, () => ({
    useCredentialGates: () => ({ isOwner }),
    useSecretPrograms: () => ({
        programsFor: (subject: string) => guards.value.find((guard) => guard.subject === subject),
        setPrograms,
    }),
}));

const { default: SecretProgramsEditor } = await import("./SecretProgramsEditor.vue");

const rowWith = (entry: Partial<SecretInventoryEntry> = {}): SecretRow =>
    secretRow(
        { key: `VPN_PASSWORD`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true, ...entry },
        { capabilities: [], extensions: [] },
    );

const mount = (row: SecretRow) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretProgramsEditor, { row, expanded: true }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const type = async (which: `window` | `android`, text: string): Promise<void> => {
        const form = el.querySelector<HTMLFormElement>(`form[data-programs="${which}"]`);
        const input = form?.querySelector<HTMLInputElement>(`input`);
        if (form === null || form === undefined || input === null || input === undefined) {
            throw new Error(`no ${which} box on the row`);
        }
        input.value = text;
        input.dispatchEvent(new Event(`input`));
        form.dispatchEvent(new Event(`submit`, { cancelable: true }));
        await nextTick();
    };
    const save = (): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === `Save`);
        if (found === undefined) {
            throw new Error(`no Save on the row`);
        }
        return found;
    };
    const chips = (): (string | undefined)[] => [...el.querySelectorAll(`.ui-chip`)].map((chip) => chip.textContent?.trim());
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, type, save, chips, done };
};

beforeEach(() => {
    setPrograms.mutateAsync.mockClear();
    isOwner.value = true;
    guards.value = [];
});

it("saves the programs, apps and any-field choice together, only when the owner presses Save", async () => {
    const { el, type, save, chips, done } = mount(rowWith());
    expect(el.textContent).toContain(`No program is listed, so typing it into any window asks first.`);
    expect(save().disabled).toBe(true);
    await type(`window`, `FortiClient.exe`);
    // One program by any case: Windows matches the name without it.
    await type(`window`, `forticlient.exe`);
    await type(`android`, `com.fortinet.forticlient`);
    expect(chips()).toEqual([`FortiClient.exe`, `com.fortinet.forticlient`]);
    el.querySelector<HTMLInputElement>(`input[role="switch"]`)?.click();
    await nextTick();
    expect(setPrograms.mutateAsync).not.toHaveBeenCalled();
    save().click();
    await nextTick();
    expect(setPrograms.mutateAsync).toHaveBeenCalledWith({
        subject: `VPN_PASSWORD`,
        programs: [`FortiClient.exe`],
        packages: [`com.fortinet.forticlient`],
        anyField: true,
    });
    done();
});

it("says so when what was typed is not a program or an app, and adds nothing", async () => {
    const { el, type, chips, done } = mount(rowWith());
    await type(`android`, `forticlient`);
    expect(el.textContent).toContain(`That is not an Android app. Write its package name, like com.fortinet.forticlient.`);
    await type(`window`, `   `);
    expect(el.textContent).toContain(`That is not a program.`);
    expect(chips()).toEqual([]);
    done();
});

it("starts from the list the sandbox keeps, and takes one away", async () => {
    guards.value = [{ subject: `VPN_PASSWORD`, programs: [`mstsc.exe`, `FortiClient.exe`], packages: [], anyField: false }];
    const { el, save, chips, done } = mount(rowWith());
    expect(chips()).toEqual([`mstsc.exe`, `FortiClient.exe`]);
    el.querySelector<HTMLButtonElement>(`button[aria-label="Remove mstsc.exe"]`)?.click();
    await nextTick();
    save().click();
    await nextTick();
    expect(setPrograms.mutateAsync).toHaveBeenCalledWith({ subject: `VPN_PASSWORD`, programs: [`FortiClient.exe`], packages: [], anyField: false });
    done();
});

it("shows anybody but the owner the list as it stands, with no controls", () => {
    isOwner.value = false;
    const listed = mount(rowWith({ programs: { programs: [`FortiClient.exe`], packages: [], anyField: true, source: `owner` } }));
    expect(listed.el.textContent).toContain(`Typed unasked only into FortiClient.exe, and anywhere else asks first. Only the owner can change that.`);
    expect(listed.el.textContent).toContain(`It may go into any field, not only password fields.`);
    expect(listed.el.querySelector(`input`)).toBeNull();
    listed.done();
    const none = mount(rowWith());
    expect(none.el.textContent).toContain(`Typing it into any window asks first. Only the owner can change that.`);
    none.done();
});
