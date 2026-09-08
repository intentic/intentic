// @vitest-environment jsdom
// Pins that the footer draws a control only where the run would honour it, and that every control it draws
// writes an explicit value: an entry never carries an absence for the harness to interpret, because the panel
// has no way to show one.
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Stubbed: the model list has its own suite; this stub renders the footer slot and can answer with a pick.
vi.mock(`../../../chat/models/ModelPicker.vue`, () => ({
    __esModule: true,
    default: defineComponent({
        props: { provider: String, model: String, unpickable: Function },
        emits: [`pick`, `close`],
        setup(props, { emit, slots }) {
            unpickable = props.unpickable as (entry: { provider: string; value: string }) => boolean;
            return () =>
                h(`div`, [
                    h(`button`, { class: `pick-claude`, onClick: () => emit(`pick`, { provider: `claude`, value: `claude-opus-5` }) }, `Claude`),
                    h(`button`, { class: `pick-codex`, onClick: () => emit(`pick`, { provider: `codex`, value: `gpt-5.6` }) }, `Codex`),
                    slots[`footer`]?.(),
                ]);
        },
    }),
}));
let unpickable: ((entry: { provider: string; value: string }) => boolean) | undefined;

// Only used as the floor when adding, where there's no entry to read a provider off.
vi.mock(`../../../chat/run/useChat`, () => ({ useChat: () => ({ provider: ref(`claude`), model: ref(`claude-haiku-4-5`) }) }));
// Empty: puts every model on the static effort scale with no `fast` badge; the badge case sets its own catalog below.
const catalog = ref<Record<string, readonly { value: string; label: string; badges?: readonly string[]; efforts?: readonly string[] }[]>>({});
vi.mock(`../../../chat/accounts/providerCatalog`, () => ({
    providerModels: catalog,
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

const { default: ModelPinPickerBody } = await import("./ModelPinPickerBody.vue");
// The state a new entry is minted at, read from its source rather than transcribed.
const { defaultRunSettings } = await import("../../../chat/models/pickerRunSettings");

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
});

// Every row the footer drew, by its label; asserted as a whole set, since what's offered is the claim under test.
const knobRows = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>(`div.flex.items-center.justify-between`)]
        .map((element) => element.querySelector(`span`)?.textContent?.trim() ?? ``)
        .filter((label) => label !== ``);

const row = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`div.flex.items-center.justify-between`)].find((element) =>
        element.querySelector(`span`)?.textContent?.trim().startsWith(label),
    );

const segment = (host: HTMLElement, label: string, option: string): HTMLButtonElement =>
    [...(row(host, label)?.querySelectorAll<HTMLButtonElement>(`button`) ?? [])].find((button) => button.textContent?.trim() === option)!;

/* The two switches, which are chips and not rows: `.composer-toggle` is the chip recipe, and picking on it
 * rather than on `aria-pressed` keeps the harness axis (ghost buttons, also pressed-state) out of the set. */
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

// A scale is a row and a switch is a chip: the effort meter keeps its label, thinking carries its own.
test("a Claude entry is offered the reasoning tiers and thinking, and neither the harness nor speed", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    expect(knobRows(host)).toEqual([`CLAUDE run`, `Reasoning effort`]);
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

/* THE CHIP WRITES BOTH OF ITS STATES, and the off one is stored rather than dropped. Absent used to be a third
 * statement — "say nothing, let the harness answer" — reachable from a stop of its own; with the stop gone,
 * dropping the field on the way out would put an entry into a state its own panel can no longer show. */
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

    expect(knobRows(host)).toContain(`Harness`);
    // Neither Claude switch is a codex question, so the chip line is not drawn at all.
    expect(chips(host)).toEqual([]);
    segment(host, `Harness`, `Claude Code`).click();
    expect(written).toEqual([{ provider: `codex`, model: `gpt-5.6`, harness: `claude-code` }]);
});

/* RE-POINTING within the provider keeps every setting; across providers it keeps only the tier, since an
 * account id and a harness belong to the provider they were chosen under. Either way the entry comes out with
 * all three run settings on it: an entry is born explicit, so what the pin holds is what its panel shows. */
test("re-pointing within the provider keeps every knob; across providers it keeps only the tier", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }, knobs: true });
    await nextTick();

    host.querySelector<HTMLButtonElement>(`.pick-codex`)!.click();
    expect(picked).toEqual([{ ...defaultRunSettings(), provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }]);

    picked.length = 0;
    host.querySelector<HTMLButtonElement>(`.pick-claude`)!.click();
    expect(picked).toEqual([{ ...defaultRunSettings(), provider: `claude`, model: `claude-opus-5`, effort: `high` }]);
});

test("a model another entry already holds cannot be pinned twice, but the entry's own can be re-picked", async () => {
    mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true, taken: [`codex:gpt-5.6`, `claude:claude-opus-5`] });
    await nextTick();

    expect(unpickable?.({ provider: `claude`, value: `claude-opus-5` })).toBe(true);
    expect(unpickable?.({ provider: `codex`, value: `gpt-5.6` })).toBe(false);
    expect(unpickable?.({ provider: `claude`, value: `claude-haiku-4-5` })).toBe(false);
});
