// An organisation's profiles are named, never given an id or a purpose: one added in this edit takes its id from its
// name as it is typed, and one the policy already carried keeps the id every bound sandbox points at when renamed.
// jsdom: renders the console's own inputs.
import "@intentic/testing/dom";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { OrgCeiling } from "@intentic/sandbox-contract/schemas/organisation";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import OrgAccessPolicy from "./OrgAccessPolicy.vue";

const profiles = ref<AccessProfile[]>([]);
const ceiling = ref<OrgCeiling>({});
let app: App | undefined;

const mount = (): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const Host = defineComponent({
        render: () =>
            h(OrgAccessPolicy, {
                profiles: profiles.value,
                "onUpdate:profiles": (value: AccessProfile[] | undefined) => (profiles.value = value ?? []),
                ceiling: ceiling.value,
                "onUpdate:ceiling": (value: OrgCeiling | undefined) => (ceiling.value = value ?? {}),
            }),
    });
    app = createApp(Host);
    app.component(`Icon`, IconStub);
    app.use(PrimeVue);
    app.mount(el);
};

const nameFields = (): HTMLInputElement[] => [...document.body.querySelectorAll<HTMLInputElement>(`details input[maxlength="60"]`)];
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

beforeEach(() => {
    profiles.value = [{ id: `ops`, label: `Ops` }];
    ceiling.value = {};
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`derives a new profile's id from its name, and keeps an existing one's through a rename`, async () => {
    mount();
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add profile`))?.click();
    await nextTick();
    expect(document.body.textContent).toContain(`Unnamed profile`);
    expect(document.body.textContent).not.toContain(`Brief`);

    const [added, existing] = nameFields();
    await type(added!, `Interns`);
    await type(existing!, `Operations`);
    expect(profiles.value.map(({ id, label }) => ({ id, label }))).toEqual([
        { id: `interns`, label: `Interns` },
        { id: `ops`, label: `Operations` },
    ]);

    // A new name that folds onto an id already in the policy gets the next free one.
    await type(added!, `OPS`);
    expect(profiles.value[0]?.id).toBe(`ops-2`);
});
