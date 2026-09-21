// @vitest-environment jsdom
// The press that produced a second entry on one model: only one local model holds the machine's server slot, so the
// loser sits in the model picker as a row that answers "isn't serving yet" forever. A rung that has been taken must
// report, never offer.
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { createApp, h, ref } from "vue";
import type { CapabilitySummary } from "@intentic/api-contract";
import type { LocalModelFitResponse } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";

const QUICK = `unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf`;
const WORK = `unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf`;

const capabilities = ref<CapabilitySummary[]>([]);
const add = vi.fn(async () => undefined);
vi.mock(`../capabilities/connect/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities, add }) }));
vi.mock(`vue-router`, () => ({ RouterLink: { template: `<a><slot /></a>` } }));

const { default: LocalModelLane } = await import("./LocalModelLane.vue");

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
    gpu: `absent`,
    gpuMemoryBytes: 0,
    budgetBytes: 27_487_790_694,
    serverReady: true,
    options: [option(QUICK, `Qwen3.5 2B`, `instant`), option(WORK, `Qwen3.8 27B`, `work`)],
    instant: { model: QUICK, context: `65536` },
    best: { model: WORK, context: `65536` },
    prefetch: { model: QUICK, state: `idle`, receivedBytes: 0, totalBytes: 0 },
};

const localModel = (id: string, model: string, status: CapabilitySummary[`status`]): CapabilitySummary =>
    ({ id, kind: `localmodel`, status, config: { model, context: `65536` }, secrets: [] }) as unknown as CapabilitySummary;

const render = (installed: CapabilitySummary[]): string => {
    capabilities.value = installed;
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(LocalModelLane, { fit: FIT }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(el);
    const html = el.innerHTML;
    app.unmount();
    el.remove();
    return html;
};

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
});

it(`shows what a failed start said, in place of the button that would repeat it`, () => {
    const html = render([localModel(`localmodel`, QUICK, { state: `error`, detail: `llama-server not running, press Update to start it` })]);
    expect(html).toContain(`llama-server not running`);
    expect(html).not.toContain(`Start now`);
});
