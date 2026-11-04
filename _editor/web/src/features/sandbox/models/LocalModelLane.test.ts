// The press that produced a second entry on one model: only one local model holds the machine's server slot, so the
// loser sits in the model picker as a row that answers "isn't serving yet" forever. A rung that has been taken must
// report, never offer.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import { localModelGb } from "@intentic/capability-catalog";
import type { LocalModelFitResponse } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { IconStub } from "@intentic/ui/testing";

const QUICK = `unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf`;
const WORK = `unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf`;

const capabilities = ref<CapabilitySummary[]>([]);
const add = jest.fn(async () => undefined);
const remove = { mutateAsync: jest.fn(async (_id: string) => undefined) };
jest.mock(`../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities, add, remove }) }));
const deleteLocalModelWeights = jest.fn(async (_model: string) => undefined);
jest.mock(`./useLocalModelFit`, () => ({ deleteLocalModelWeights }));
jest.mock(`vue-router`, () => ({ RouterLink: { template: `<a><slot /></a>` } }));

const { default: LocalModelLane } = await import("./LocalModelLane.vue");
const { forgetOperations } = await import("../../../workbench/operations/operations");
const { localPrefetchStopped } = await import("./localPrefetch");

// The add is kept in the operations ledger, which is module state: a run left there would follow one test into the next.
afterEach(() => forgetOperations());

const option = (model: string, label: string, tier: `instant` | `work`) => ({
    model,
    label,
    tier,
    weightsBytes: 1_280_835_840,
    held: true,
    windows: [{ tokens: 65_536, totalBytes: 6_000_000_000, fits: true }],
});

const FIT: LocalModelFitResponse = {
    memoryBytes: 34_359_738_368,
    memoryCapped: false,
    budgetBytes: 27_487_790_694,
    serverReady: true,
    options: [option(QUICK, `Qwen3.5 2B`, `instant`), option(WORK, `Qwen3.8 27B`, `work`)],
    instant: { model: QUICK, context: `65536` },
    best: { model: WORK, context: `65536` },
    prefetch: { model: QUICK, state: `idle`, receivedBytes: 0, totalBytes: 0 },
};

const localModel = (id: string, model: string, status: CapabilitySummary[`status`]): CapabilitySummary =>
    ({ id, kind: `localmodel`, status, config: { model, context: `65536` }, secrets: [] }) as unknown as CapabilitySummary;

const renderWith = (fit: LocalModelFitResponse, installed: CapabilitySummary[]): string => {
    capabilities.value = installed;
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(LocalModelLane, { fit }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(el);
    const html = el.innerHTML;
    app.unmount();
    el.remove();
    return html;
};

const render = (installed: CapabilitySummary[]): string => renderWith(FIT, installed);

it(`offers both rungs while nothing is installed`, () => {
    const html = render([]);
    expect(html).toContain(`Start now`);
    expect(html).toContain(`Run it`);
});

// Matched on the weights, not the id: the entry that caused this was named `localmodel-qwen3-5-2b`, not `localmodel`.
it(`stops offering a model some entry already holds, whatever that entry is called`, () => {
    const html = render([localModel(`localmodel-qwen3-5-2b`, QUICK, { state: `pending`, detail: `loading the model` })]);
    expect(html).not.toContain(`Start now`);
    expect(html).toContain(`loading the model`);
    // The other rung is untouched: one model taken is not the lane taken.
    expect(html).toContain(`Run it`);
});

it(`says a served model is ready rather than repeating the daemon's row detail`, () => {
    const html = render([localModel(`localmodel`, WORK, { state: `active`, detail: `Qwen3.8 27B · 64k window` })]);
    expect(html).toContain(`Ready`);
    expect(html).not.toContain(`Run it`);
    expect(html).not.toContain(`Qwen3.8 27B · 64k window`);
    // Taken, its download is behind it: only the rung still on offer says where its weights are.
    expect(html.match(/Downloaded/g)).toHaveLength(1);
    expect(html).toContain(`64k context`);
});

it(`shows what a failed start said, in place of the button that would repeat it`, () => {
    const html = render([localModel(`localmodel`, QUICK, { state: `error`, detail: `llama-server not running, press Update to start it` })]);
    expect(html).toContain(`llama-server not running`);
    expect(html).not.toContain(`Start now`);
});

// The quick-jobs model writes commit messages and titles and is refused a chat turn, so a served one is reported as what
// it is and pointed at the list that uses it, never offered as the model to chat with.
it(`says a served quick-jobs model is ready for quick jobs, and points at where it is used`, () => {
    const html = render([localModel(`localmodel`, QUICK, { state: `active`, detail: `Qwen3.5 2B · 64k window` })]);
    expect(html).toContain(`Ready`);
    expect(html).toContain(`Choose it for commit messages and titles`);
});

// A serving row's sentence repeats the rung's own name and window, so it gets no line of its own.
it(`calls a serving model ready without repeating what its row already names`, () => {
    const html = render([localModel(`localmodel`, WORK, { state: `active`, detail: `Qwen3.8 27B · 64k window` })]);
    expect(html).toContain(`Ready`);
    expect(html).not.toContain(`Qwen3.8 27B · 64k window`);
});

// Pressing a rung and waiting for it to serve is the whole errand; only a model that can run a chat ends it in one.
it(`hands a served model on to chat only when it can run one`, async () => {
    const started = async (model: string): Promise<string[]> => {
        capabilities.value = [];
        const ready: string[] = [];
        const el = document.createElement(`div`);
        document.body.append(el);
        const app = createApp({ render: () => h(LocalModelLane, { fit: FIT, onReady: (provider: string) => ready.push(provider) }) });
        app.use(PrimeVue);
        app.component(`Icon`, IconStub);
        app.mount(el);
        const label = model === QUICK ? `Start now` : `Run it`;
        [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label))?.click();
        await nextTick();
        await Promise.resolve();
        capabilities.value = [localModel(`served`, model, { state: `active`, detail: `serving` })];
        await nextTick();
        app.unmount();
        el.remove();
        return ready;
    };
    expect(await started(WORK)).toEqual([`endpoint/served`]);
    expect(await started(QUICK)).toEqual([]);
});

it(`says what the offers were sized against: the memory free now, not the total`, () => {
    const html = renderWith({ ...FIT, fullSpeedBytes: 6 * 1024 ** 3 }, []);
    expect(html).toContain(`Picks below fit in the ${localModelGb(6 * 1024 ** 3)} of memory free now.`);
    const none = renderWith({ ...FIT, instant: undefined, best: undefined, fullSpeedBytes: 1024 ** 3 }, []);
    expect(none).toContain(`Nothing on the curated list runs at full speed in the ${localModelGb(1024 ** 3)} free here.`);
});

// The costs of an offer read as short facts, not a sentence about them.
it(`lists what an offer costs as facts`, () => {
    const html = renderWith({ ...FIT, options: FIT.options.map((entry) => ({ ...entry, held: false })) }, []);
    expect(html).toContain(`${localModelGb(1_280_835_840)} download`);
    expect(html).toContain(`uses about ${localModelGb(6_000_000_000)} while running`);
    expect(html).toContain(`64k context`);
});

// THE WAY BACK. A model costs gigabytes, and the lane once had no press that gave them back: a taken rung only reported,
// and the prefetch fetched the quick model on a first visit with nothing to undo it once it had landed.
describe(`taking a model back`, () => {
    const mounted = (fit: LocalModelFitResponse, installed: CapabilitySummary[]): HTMLElement => {
        capabilities.value = installed;
        const el = document.createElement(`div`);
        document.body.append(el);
        const app = createApp({ render: () => h(LocalModelLane, { fit }) });
        app.use(PrimeVue);
        app.component(`Icon`, IconStub);
        app.directive(`tooltip`, {});
        app.mount(el);
        return el;
    };
    const discard = (el: HTMLElement, key: string): HTMLButtonElement | null =>
        el.querySelector<HTMLButtonElement>(`[data-local-model-discard="${key}"]`);
    // The dialog is teleported to <body>, off the lane's own element.
    const confirmNamed = (name: string): HTMLButtonElement | undefined =>
        [...document.body.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === name);
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 5; i += 1) {
            await nextTick();
            await Promise.resolve();
        }
    };

    afterEach(() => {
        document.body.innerHTML = ``;
        remove.mutateAsync.mockClear();
        deleteLocalModelWeights.mockClear();
        localPrefetchStopped.value = false;
    });

    it(`offers it only where there is something to give back: an entry, or weights on disk`, () => {
        const nothingHeld = mounted({ ...FIT, options: FIT.options.map((entry) => ({ ...entry, held: false })) }, []);
        expect(discard(nothingHeld, `instant`)).toBeNull();
        expect(discard(nothingHeld, `best`)).toBeNull();
        document.body.innerHTML = ``;

        const el = mounted(FIT, [localModel(`localmodel`, WORK, { state: `active`, detail: `serving` })]);
        expect(discard(el, `best`)?.getAttribute(`aria-label`)).toBe(`Remove Qwen3.8 27B`);
        expect(discard(el, `instant`)?.getAttribute(`aria-label`)).toBe(`Delete the download`);
    });

    it(`removes a taken model and deletes its weights, once confirmed`, async () => {
        const el = mounted(FIT, [localModel(`localmodel-27b`, WORK, { state: `active`, detail: `serving` })]);
        discard(el, `best`)!.click();
        await settle();
        expect(document.body.textContent).toContain(`Remove Qwen3.8 27B?`);
        expect(remove.mutateAsync).not.toHaveBeenCalled();
        confirmNamed(`Remove`)!.click();
        await settle();
        expect(remove.mutateAsync).toHaveBeenCalledWith(`localmodel-27b`);
        expect(deleteLocalModelWeights).toHaveBeenCalledWith(WORK);
        // Not the quick model: the prefetch stays as it was.
        expect(localPrefetchStopped.value).toBe(false);
    });

    it(`deletes a download nobody took, and remembers the quick model as declined so it is not fetched again`, async () => {
        const el = mounted(FIT, []);
        discard(el, `instant`)!.click();
        await settle();
        expect(document.body.textContent).toContain(`Delete the downloaded Qwen3.5 2B?`);
        confirmNamed(`Delete`)!.click();
        await settle();
        expect(remove.mutateAsync).not.toHaveBeenCalled();
        expect(deleteLocalModelWeights).toHaveBeenCalledWith(QUICK);
        expect(localPrefetchStopped.value).toBe(true);
    });
});
