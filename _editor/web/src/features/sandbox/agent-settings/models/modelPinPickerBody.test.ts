// Pins that the footer draws a control only where the run would honour it, and that every control it draws
// writes an explicit value: an entry never carries an absence for the harness to interpret, because the panel
// has no way to show one.
import "@intentic/testing/dom";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Stubbed: the model list has its own suite; this stub renders the footer slot and can answer with a pick.
jest.mock(`../../../chat/models/ModelPicker.vue`, () => ({
    __esModule: true,
    default: defineComponent({
        props: { provider: String, model: String, unpickable: Function },
        emits: [`pick`, `close`],
        setup(props, { emit, slots }) {
            unpickable = props.unpickable as (entry: { provider: string; value: string }) => boolean;
            ticked = props;
            return () =>
                h(`div`, [
                    h(`button`, { class: `pick-claude`, onClick: () => emit(`pick`, { provider: `claude`, value: `claude-opus-5` }) }, `Claude`),
                    h(`button`, { class: `pick-codex`, onClick: () => emit(`pick`, { provider: `codex`, value: `gpt-5.6` }) }, `Codex`),
                    h(
                        `button`,
                        { class: `pick-gemini`, onClick: () => emit(`pick`, { provider: `gemini`, value: `gemini-3-flash-lite` }) },
                        `Gemini`,
                    ),
                    slots[`footer`]?.(),
                ]);
        },
    }),
}));
let unpickable: ((entry: { provider: string; value: string }) => boolean) | undefined;
// The pair the list checkmarks, as handed over live.
let ticked: { readonly provider?: string; readonly model?: string } | undefined;

// Only used as the floor when adding, where there's no entry to read a provider off.
jest.mock(`../../../../models/conversations/run/useChat`, () => ({ useChat: () => ({ provider: ref(`claude`), model: ref(`claude-haiku-4-5`) }) }));
// Empty: puts every model on the static effort scale with no `fast` badge; the badge case sets its own catalog below.
const catalog = ref<Record<string, readonly { value: string; label: string; badges?: readonly string[]; efforts?: readonly string[] }[]>>({});
jest.mock(`../../../../models/providers/providerCatalog`, () => ({
    providerModels: catalog,
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
    // <ProviderLogo> names it; bun links an ESM import against exactly what this factory returns.
    providerGlyph: () => `cpu`,
}));

const { default: ModelPinPickerBody } = await import("./ModelPinPickerBody.vue");
const { advertisedLoops } = await import("../../../../models/providers/offeredLoops");

let app: App | undefined;
const written: unknown[] = [];
const picked: unknown[] = [];

const mount = (props: Record<string, unknown>): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(ModelPinPickerBody, {
                ...props,
                onConfigure: (pin: unknown) => written.push(pin),
                onPick: (pin: unknown) => picked.push(pin),
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    catalog.value = {};
    written.length = 0;
    picked.length = 0;
    unpickable = undefined;
    ticked = undefined;
});

// Every labelled row the footer drew, by its label; asserted as a whole set, since what's offered is the claim under test.
// The toolbar under them carries no labels: its controls' own words are the label.
const knobRows = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>(`span.uppercase`)].map((label) => label.textContent?.trim() ?? ``).filter((label) => label !== ``);

// A labelled row, by its label: the effort meter's.
const row = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`span.uppercase`)].find((span) => span.textContent?.trim() === label)?.parentElement ?? undefined;

// The harness: one segment per offered loop, at the toolbar's left end.
const loops = (host: HTMLElement): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>(`[role="tablist"] button`)];
const segment = (host: HTMLElement, option: string): HTMLButtonElement => loops(host).find((button) => button.textContent?.trim() === option)!;

/* The two switches, which are chips and not rows: `.composer-toggle` is the chip recipe. */
const chips = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>(`button.composer-toggle`)].map((chip) => chip.textContent?.trim() ?? ``);
const chip = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button.composer-toggle`)].find((candidate) => candidate.textContent?.trim() === label)!;

test("a list whose entries carry no run settings gets the list and no footer at all", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: false });
    await nextTick();

    expect(knobRows(host)).toEqual([]);
});

test("adding draws no footer either: there is nothing to configure until the entry exists", async () => {
    const host = mount({ knobs: true });
    await nextTick();

    expect(knobRows(host)).toEqual([]);
});

// The chat's own model was once ticked as "current" on a job that did not run it, and it was picked as one.
test("adding ticks the job's own first model, and nothing for a job with none, never the chat's", async () => {
    mount({ current: { provider: `codex`, model: `gpt-5.6` } });
    await nextTick();
    expect([ticked?.provider, ticked?.model]).toEqual([`codex`, `gpt-5.6`]);
    app?.unmount();

    // The chat's provider only decides which lane the list opens on.
    mount({});
    await nextTick();
    expect([ticked?.provider, ticked?.model]).toEqual([`claude`, ``]);
});

// A scale is a row and a switch is a chip: the effort meter keeps its label, the chips sit on the toolbar under it.
test("a Claude entry is offered the reasoning tiers and thinking, and neither the harness nor speed", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    expect(knobRows(host)).toEqual([`Reasoning effort`]);
    expect(loops(host)).toEqual([]);
    expect(chips(host)).toEqual([`Extended thinking`]);
});

test("speed is offered only for a model whose catalog row publishes it", async () => {
    catalog.value = { claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5`, badges: [`fast`] }] };
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    expect(chips(host)).toEqual([`Extended thinking`, `Fast speed`]);
    chip(host, `Fast speed`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5`, fast: true }]);
});

/* THE CHIP WRITES BOTH OF ITS STATES, and the off one is stored rather than dropped. */
test("switching a chip off stores the off rather than dropping the field", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5`, thinking: true }, knobs: true });
    await nextTick();

    chip(host, `Extended thinking`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5`, thinking: false }]);
});

test("the top tier follows the entry's own thinking: only switching it off takes Max away", async () => {
    catalog.value = { claude: [{ value: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }] };
    const rungs = (host: HTMLElement): string[] =>
        [...(row(host, `Reasoning effort`)?.querySelectorAll<HTMLButtonElement>(`button.composer-effort-seg`) ?? [])].map(
            (button) => button.getAttribute(`aria-label`) ?? ``,
        );

    const unpinned = mount({ pin: { provider: `claude`, model: `claude-opus-5` }, knobs: true });
    await nextTick();
    expect(rungs(unpinned)).toEqual([`Low`, `Medium`, `High`, `X-High`, `Max`]);

    app?.unmount();
    document.body.innerHTML = ``;
    const off = mount({ pin: { provider: `claude`, model: `claude-opus-5`, thinking: false }, knobs: true });
    await nextTick();
    expect(rungs(off)).toEqual([`Low`, `Medium`, `High`, `X-High`]);
});

test("an entry on a provider that published no scale gets a floor with no Max in it", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true });
    await nextTick();

    expect(
        [...(row(host, `Reasoning effort`)?.querySelectorAll<HTMLButtonElement>(`button.composer-effort-seg`) ?? [])].map((button) =>
            button.getAttribute(`aria-label`),
        ),
    ).toEqual([`Low`, `Medium`, `High`, `X-High`]);
});

test("a codex entry is offered the harness axis, and picking a chip writes it", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true });
    await nextTick();

    expect(loops(host).length).toBeGreaterThan(1);
    // Neither Claude switch is a codex question, so the toolbar holds the harness alone.
    expect(chips(host)).toEqual([]);
    segment(host, `Claude Code`).click();
    expect(written).toEqual([{ provider: `codex`, model: `gpt-5.6`, harness: `claude-code` }]);
});

// One segment per loop, each named for itself; the default's stores `native`, which every daemon reads, never its own name.
test("the loop chips are the offered loops, the default's lit for native and storing native", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6`, harness: `claude-code` }, knobs: true });
    await nextTick();

    expect(loops(host).map((button) => [button.textContent?.trim(), button.getAttribute(`aria-selected`)])).toEqual([
        [`Codex`, `false`],
        [`Claude Code`, `true`],
    ]);
    // The vendor's own terms for the loop picked ride behind the one (i) beside it, as a hint and nothing louder.
    const hint = host.querySelector<HTMLElement>(`.cursor-help`)!.parentElement!;
    hint.dispatchEvent(new MouseEvent(`mouseenter`));
    await nextTick();
    expect(document.body.textContent).toContain(`Vendor terms`);
    hint.dispatchEvent(new MouseEvent(`mouseleave`));
    segment(host, `Codex`).click();
    expect(written).toEqual([{ provider: `codex`, model: `gpt-5.6`, harness: `native` }]);
});

// A lone segment would be a label pretending to be a control: the one loop is named, with what it can't do, and offered nothing.
test("a daemon that offers the provider one loop draws no loop choice, only the loop's name", async () => {
    advertisedLoops.value = { codex: [`codex`] };
    try {
        const host = mount({ pin: { provider: `codex`, model: `gpt-5.6`, harness: `claude-code` }, knobs: true });
        await nextTick();
        expect(loops(host)).toEqual([]);
        expect(host.textContent).toContain(`Codex`);
    } finally {
        advertisedLoops.value = undefined;
    }
});

/* RE-POINTING within the provider keeps every setting; across providers it keeps only the tier. */
test("re-pointing within the provider keeps every knob; across providers it keeps only the tier", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }, knobs: true });
    await nextTick();

    host.querySelector<HTMLButtonElement>(`.pick-codex`)!.click();
    expect(picked).toEqual([{ provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }]);

    picked.length = 0;
    host.querySelector<HTMLButtonElement>(`.pick-claude`)!.click();
    expect(picked).toEqual([{ provider: `claude`, model: `claude-opus-5`, effort: `high`, thinking: true }]);
});

// OpenCode carries an effort tier as a model variant, so the tier rides along; it has no thinking switch, so that does not.
test("a Google entry keeps the effort tier its loop honours, and no thinking knob it cannot", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5`, effort: `high`, thinking: false }, knobs: true });
    await nextTick();

    host.querySelector<HTMLButtonElement>(`.pick-gemini`)!.click();
    expect(picked).toEqual([{ provider: `gemini`, model: `gemini-3-flash-lite`, effort: `high` }]);
});

test("a model another entry already holds cannot be pinned twice, but the entry's own can be re-picked", async () => {
    mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true, taken: [`codex:gpt-5.6`, `claude:claude-opus-5`] });
    await nextTick();

    expect(unpickable?.({ provider: `claude`, value: `claude-opus-5` })).toBe(true);
    expect(unpickable?.({ provider: `codex`, value: `gpt-5.6` })).toBe(false);
    expect(unpickable?.({ provider: `claude`, value: `claude-haiku-4-5` })).toBe(false);
});
