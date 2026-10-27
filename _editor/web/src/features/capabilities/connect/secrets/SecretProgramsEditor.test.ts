// A sandbox-held secret's program guard as its open row shows it: read as its answer ("Asks each time", or the programs
// and apps it is typed into unasked), and changed in a panel hanging off that answer, where programs and Android apps are
// added as typed and saved together with "any field" only when the owner presses Save. What is not a program or a package
// is said and not added, and anybody but the owner reads the answer with nothing to press.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import type { SecretInventoryEntry, SecretProgramGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { type SecretRow, secretRow } from "../../../sandbox/secrets/secretRows";
import { IconStub } from "@intentic/ui/testing";
import { SecretPopoverStub } from "./SecretPopover.testing";

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

jest.mock(`./SecretPopover.vue`, () => ({ default: SecretPopoverStub }));

const { default: SecretProgramsEditor } = await import("./SecretProgramsEditor.vue");

// Lets a save's awaited answer reach the template.
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

const rowWith = (entry: Partial<SecretInventoryEntry> = {}): SecretRow =>
    secretRow(
        { key: `VPN_PASSWORD`, kind: `env`, status: `set`, requiredBy: [], storedAt: `desired-state/.env`, revealable: true, ...entry },
        { capabilities: [], extensions: [] },
    );

const mount = (row: SecretRow) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretProgramsEditor, { row }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const answer = (): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>(`button[aria-label^="Change what it may be typed into"]`);
    const open = async (): Promise<void> => {
        const found = answer();
        if (found === null) {
            throw new Error(`no answer to press on the row`);
        }
        found.click();
        await nextTick();
    };
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
    return { el, answer, open, type, save, chips, done };
};

beforeEach(() => {
    setPrograms.mutateAsync.mockClear();
    isOwner.value = true;
    guards.value = [];
});

it("reads as asking each time, and saves the programs, apps and any-field choice together only on Save", async () => {
    const { el, open, type, save, chips, done } = mount(rowWith());
    expect(el.textContent).toContain(`Typed into`);
    expect(el.textContent).toContain(`Asks each time`);
    await open();
    expect(el.textContent).toContain(`Nothing listed, so typing it into any window asks first.`);
    await type(`window`, `FortiClient.exe`);
    // One program by any case: Windows matches the name without it.
    await type(`window`, `forticlient.exe`);
    await type(`android`, `com.fortinet.forticlient`);
    expect(chips()).toEqual([`FortiClient.exe`, `com.fortinet.forticlient`]);
    el.querySelector<HTMLInputElement>(`input[role="switch"]`)?.click();
    await nextTick();
    expect(setPrograms.mutateAsync).not.toHaveBeenCalled();
    save().click();
    await settled();
    expect(setPrograms.mutateAsync).toHaveBeenCalledWith({
        subject: `VPN_PASSWORD`,
        programs: [`FortiClient.exe`],
        packages: [`com.fortinet.forticlient`],
        anyField: true,
    });
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    done();
});

it("says so when what was typed is not a program or an app, and adds nothing", async () => {
    const { el, open, type, chips, done } = mount(rowWith());
    await open();
    await type(`android`, `forticlient`);
    expect(el.textContent).toContain(`That is not an Android app. Write its package name, like com.fortinet.forticlient.`);
    await type(`window`, `   `);
    expect(el.textContent).toContain(`That is not a program.`);
    expect(chips()).toEqual([]);
    done();
});

it("reads the list the sandbox keeps as its answer, and takes one away", async () => {
    guards.value = [{ subject: `VPN_PASSWORD`, programs: [`mstsc.exe`, `FortiClient.exe`], packages: [], anyField: false }];
    const { el, open, save, chips, done } = mount(rowWith());
    expect(el.textContent).toContain(`mstsc.exe, FortiClient.exe`);
    expect(el.textContent).toContain(`Password fields only · anywhere else asks`);
    await open();
    expect(chips()).toEqual([`mstsc.exe`, `FortiClient.exe`]);
    el.querySelector<HTMLButtonElement>(`button[aria-label="Remove mstsc.exe"]`)?.click();
    await nextTick();
    save().click();
    await settled();
    expect(setPrograms.mutateAsync).toHaveBeenCalledWith({ subject: `VPN_PASSWORD`, programs: [`FortiClient.exe`], packages: [], anyField: false });
    done();
});

it("closes on Save without writing when nothing changed", async () => {
    const { el, open, save, done } = mount(rowWith());
    await open();
    save().click();
    await settled();
    expect(setPrograms.mutateAsync).not.toHaveBeenCalled();
    expect(el.querySelector(`[data-popover]`)).toBeNull();
    done();
});

it("shows anybody but the owner the answer as it stands, with nothing to press", () => {
    isOwner.value = false;
    const listed = mount(rowWith({ programs: { programs: [`FortiClient.exe`], packages: [], anyField: true, source: `owner` } }));
    expect(listed.el.textContent).toContain(`FortiClient.exe`);
    expect(listed.el.textContent).toContain(`Any field · anywhere else asks`);
    expect(listed.answer()).toBeNull();
    expect(listed.el.querySelector(`input`)).toBeNull();
    listed.done();
    const none = mount(rowWith());
    expect(none.el.textContent).toContain(`Asks each time`);
    none.done();
});
