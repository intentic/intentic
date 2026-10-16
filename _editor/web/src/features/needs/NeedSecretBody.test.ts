// A secret need's card, where one of the owner's computers has a keyring: the value is kept in the sandbox unless the
// person picks a computer, asking each time unless they pick another share, and a computer whose keyring is locked is said
// to hold it only once it is next unlocked, before the press and after it. With no keyring answering there is no choice.
import "@intentic/testing/dom";
import type { Need, SecretNeed } from "@intentic/sandbox-contract/schemas/needs";
import type { SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";

const provideSecret = { mutateAsync: jest.fn(async (_input: { id: string; value: string; keepOn?: { device: string; mode: string } }): Promise<void> => undefined) };
jest.mock(`../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ provideSecret, answer: { mutateAsync: jest.fn() } }) }));
// The need's answer runs its task and says how it ended, as the operations ledger would.
jest.mock(`./needAnswer`, () => ({
    useNeedAnswer: () => ({
        busy: ref(false),
        notice: ref(undefined),
        answer: async (options: { task: () => Promise<void> }): Promise<{ state: `done` }> => {
            await options.task();
            return { state: `done` };
        },
    }),
}));
const keyrings = ref<SandboxKeyring[]>([]);
jest.mock(`../capabilities/connect/secrets/useKeyrings`, () => ({
    useKeyrings: () => ({ keyrings, online: computed(() => keyrings.value.filter((keyring) => keyring.online)) }),
}));
const say = jest.fn((_message: string) => undefined);
jest.mock(`../../workbench/notifications/notifications`, () => ({ useNotifications: () => ({ say }) }));
// The masked field is its own component with its own suite; here it is only somewhere to type.
jest.mock(`../../parts/capabilities/SecretField.vue`, () => ({
    default: defineComponent({
        props: { modelValue: { type: String, default: `` } },
        emits: [`update:modelValue`],
        setup: (props, { emit }) => () =>
            h(`input`, {
                type: `password`,
                value: props.modelValue,
                onInput: (event: Event) => {
                    if (event.target instanceof HTMLInputElement) {
                        emit(`update:modelValue`, event.target.value);
                    }
                },
            }),
    }),
}));
jest.mock(`../../components/ChatDecisionButton.vue`, () => ({
    default: defineComponent({
        props: { disabled: Boolean },
        setup: (props, { slots }) => () => h(`button`, { type: `button`, disabled: props.disabled }, slots[`default`]?.()),
    }),
}));

const { default: NeedSecretBody } = await import("./NeedSecretBody.vue");

const SUBJECT: SecretNeed = { kind: `secret`, name: `VPN_PASSWORD` };
const NEED: Need = { id: `need-1`, conversationId: `c-1`, title: `VPN password`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedSecretBody, { need: NEED, subject: SUBJECT }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const typeValue = async (text: string): Promise<void> => {
        const input = el.querySelector<HTMLInputElement>(`input[type="password"]`);
        if (input === null) {
            throw new Error(`no value field on the card`);
        }
        input.value = text;
        input.dispatchEvent(new Event(`input`));
        await nextTick();
    };
    const button = (label: string): HTMLButtonElement => {
        const found = [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
        if (found === undefined) {
            throw new Error(`no "${label}" button on the card`);
        }
        return found;
    };
    const press = async (label: string): Promise<void> => {
        button(label).click();
        await nextTick();
        await Promise.resolve();
        await nextTick();
    };
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, typeValue, button, press, done };
};

beforeEach(() => {
    provideSecret.mutateAsync.mockClear();
    say.mockClear();
    keyrings.value = [];
});

it("keeps it in the sandbox, with no choice offered, while no computer's keyring answers", async () => {
    keyrings.value = [{ machine: `rog`, online: false, shared: 0 }];
    const { el, typeValue, press, done } = mount();
    expect(el.querySelector(`[data-keep-on]`)).toBeNull();
    expect(el.textContent).toContain(`Stored in this sandbox as VPN_PASSWORD.`);
    await typeValue(`hunter2`);
    await press(`Save`);
    expect(provideSecret.mutateAsync).toHaveBeenCalledWith({ id: `need-1`, value: `hunter2`, keepOn: undefined });
    done();
});

it("keeps it on the computer picked, asking each time by default", async () => {
    keyrings.value = [{ machine: `rog`, online: true, locked: false, shared: 0 }];
    const { el, typeValue, press, done } = mount();
    // The sandbox stays the default: the choice is offered, not made.
    expect(el.querySelector(`button[role="tab"][aria-selected="true"]`)?.textContent?.trim()).toBe(`Keep it in the sandbox`);
    await press(`Keep it on my computer`);
    expect(el.textContent).toContain(`Each use asks you on rog first, with Windows Hello or the keyring's passphrase.`);
    expect(el.textContent).toContain(`Kept in the keyring on rog as VPN_PASSWORD.`);
    await typeValue(`hunter2`);
    await press(`Save`);
    expect(provideSecret.mutateAsync).toHaveBeenCalledWith({ id: `need-1`, value: `hunter2`, keepOn: { device: `rog`, mode: `each-use` } });
    // Unlocked, it is taken in at once: nothing to say after.
    expect(say).not.toHaveBeenCalled();
    done();
});

it("says a locked computer holds it from its next unlock, before the press and after it", async () => {
    keyrings.value = [
        { machine: `rog`, online: true, locked: false, shared: 0 },
        { machine: `omen`, online: true, locked: true, shared: 0 },
    ];
    const { el, typeValue, press, done } = mount();
    await press(`Keep it on my computer`);
    await press(`omen`);
    await press(`While I'm at the computer`);
    expect(el.textContent).toContain(`omen is locked: the value waits there until its keyring is next unlocked.`);
    await typeValue(`hunter2`);
    await press(`Save`);
    expect(provideSecret.mutateAsync).toHaveBeenCalledWith({ id: `need-1`, value: `hunter2`, keepOn: { device: `omen`, mode: `while-here` } });
    expect(say).toHaveBeenCalledWith(`Sent to omen. It waits there until its keyring is next unlocked.`);
    done();
});
