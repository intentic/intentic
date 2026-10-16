// The keyrings on the owner's computers, and pairing two of them: offered only while two answer, sent only for the two
// picked, and said while both prompts are up with the fingerprints each should show, then with the ones both showed.
import "@intentic/testing/dom";
import type { SandboxKeyring } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { computed, createApp, h, nextTick, ref } from "vue";

type Fingerprints = { fingerprints: { a: string; b: string } };
let settle: ((value: Fingerprints) => void) | undefined;
const pair = {
    mutateAsync: jest.fn(
        (_input: { a: string; b: string }) =>
            new Promise<Fingerprints>((resolve) => {
                settle = resolve;
            }),
    ),
};
const keyrings = ref<SandboxKeyring[]>([]);
jest.mock(`../../capabilities/connect/secrets/useKeyrings`, () => ({
    useKeyrings: () => ({ keyrings, online: computed(() => keyrings.value.filter((keyring) => keyring.online)), pair }),
}));

const { default: SecretKeyrings } = await import("./SecretKeyrings.vue");

const mount = () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SecretKeyrings) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const find = (label: string): HTMLButtonElement | undefined =>
        [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.trim() === label);
    const press = async (label: string): Promise<void> => {
        const found = find(label);
        if (found === undefined) {
            throw new Error(`no "${label}" button`);
        }
        found.click();
        await nextTick();
    };
    const done = (): void => {
        app.unmount();
        el.remove();
    };
    return { el, find, press, done };
};

beforeEach(() => {
    pair.mutateAsync.mockClear();
    settle = undefined;
    keyrings.value = [
        { machine: `rog`, online: true, locked: false, shared: 2, pendingInbox: 1, sync: { fingerprint: `AB12 CD34`, peers: [] } },
        { machine: `omen`, online: true, locked: true, shared: 0, sync: { fingerprint: `EF56 7890`, peers: [] } },
        { machine: `laptop`, online: false, shared: 0 },
    ];
});

it("lists each keyring with where it stands and what it holds here", () => {
    const { el, done } = mount();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Shared here: 2 · Waiting for its next unlock: 1`);
    expect(text).toContain(`Unlocked`);
    expect(text).toContain(`Locked`);
    expect(text).toContain(`Offline`);
    done();
});

it("pairs the two picked, saying what each prompt shows while both wait, then what both showed", async () => {
    const { el, find, press, done } = mount();
    await press(`Pair`);
    // Only the two that answer can be picked; both are picked already.
    expect([...el.querySelectorAll(`button[aria-pressed]`)].map((chip) => [chip.textContent?.trim(), chip.getAttribute(`aria-pressed`)])).toEqual([
        [`rog`, `true`],
        [`omen`, `true`],
    ]);
    await press(`Pair these two`);
    expect(pair.mutateAsync).toHaveBeenCalledWith({ a: `rog`, b: `omen` });
    expect(el.textContent).toContain(`Confirm on both computers.`);
    expect(el.textContent).toContain(`rog: AB12 CD34`);
    expect(el.textContent).toContain(`omen: EF56 7890`);
    expect(el.textContent).toContain(`Say yes only where they match.`);
    expect(find(`Pair these two`)?.disabled).toBe(true);

    settle?.({ fingerprints: { a: `AB12 CD34`, b: `EF56 7890` } });
    await Promise.resolve();
    await nextTick();
    expect(el.textContent).toContain(`Paired rog and omen.`);
    expect(find(`Pair these two`)).toBeUndefined();
    await press(`Done`);
    expect(el.textContent).not.toContain(`Paired rog and omen.`);
    done();
});

it("offers no pairing while fewer than two answer", () => {
    keyrings.value = keyrings.value.map((keyring) => (keyring.machine === `omen` ? { ...keyring, online: false } : keyring));
    const { find, done } = mount();
    expect(find(`Pair`)).toBeUndefined();
    done();
});
