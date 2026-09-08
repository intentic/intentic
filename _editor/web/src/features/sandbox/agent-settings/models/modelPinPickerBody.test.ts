// @vitest-environment jsdom
// Pins that the footer draws a knob only where the run would honour it, and that it writes ABSENT (no field)
// separately from explicit OFF, never collapsing the two.
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

test("a Claude entry is offered the reasoning tiers and thinking, and neither the harness nor speed", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    expect(knobRows(host)).toEqual([`CLAUDE run`, `Reasoning effort`, `Extended thinking`]);
});

test("speed is offered only for a model whose catalog row publishes it", async () => {
    catalog.value = { claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5`, badges: [`fast`] }] };
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    expect(knobRows(host)).toContain(`Speed`);
    segment(host, `Speed`, `Fast`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5`, fast: true }]);

    // Back to Standard drops the field rather than storing `false`; absent is what the schema means by standard.
    written.length = 0;
    segment(host, `Speed`, `Standard`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("thinking keeps its three stops apart: absent sends nothing, off sends off", async () => {
    const host = mount({ pin: { provider: `claude`, model: `claude-haiku-4-5` }, knobs: true });
    await nextTick();

    segment(host, `Extended thinking`, `Off`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5`, thinking: false }]);

    written.length = 0;
    segment(host, `Extended thinking`, `Default`).click();
    expect(written).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("the top tier follows the entry's own thinking: only switching it off takes Max away", async () => {
    catalog.value = { claude: [{ value: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }] };
    const rungs = (host: HTMLElement): string[] =>
        // Meter segments only: the row also holds the reset ×, kept in the tab order even when hidden.
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
    expect(knobRows(host)).not.toContain(`Extended thinking`);
    segment(host, `Harness`, `Claude Code`).click();
    expect(written).toEqual([{ provider: `codex`, model: `gpt-5.6`, harness: `claude-code` }]);
});

test("re-pointing within the provider keeps every knob; across providers it keeps only the tier", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }, knobs: true });
    await nextTick();

    host.querySelector<HTMLButtonElement>(`.pick-codex`)!.click();
    expect(picked).toEqual([{ provider: `codex`, model: `gpt-5.6`, effort: `high`, harness: `claude-code` }]);

    picked.length = 0;
    host.querySelector<HTMLButtonElement>(`.pick-claude`)!.click();
    expect(picked).toEqual([{ provider: `claude`, model: `claude-opus-5`, effort: `high` }]);
});

test("a model another entry already holds cannot be pinned twice, but the entry's own can be re-picked", async () => {
    mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true, taken: [`codex:gpt-5.6`, `claude:claude-opus-5`] });
    await nextTick();

    expect(unpickable?.({ provider: `claude`, value: `claude-opus-5` })).toBe(true);
    expect(unpickable?.({ provider: `codex`, value: `gpt-5.6` })).toBe(false);
    expect(unpickable?.({ provider: `claude`, value: `claude-haiku-4-5` })).toBe(false);
});
