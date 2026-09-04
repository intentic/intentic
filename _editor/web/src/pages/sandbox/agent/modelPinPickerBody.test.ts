// @vitest-environment jsdom
//
// THE FOOTER OF THE SETTINGS PAGE'S MODEL PICKER: which knobs an entry is offered, and what each one writes.
//
// Two claims, and both are about honesty rather than plumbing. A knob is drawn only where the run would honour
// it — the harness axis belongs to the two providers that have one, extended thinking and speed to Claude — so
// the panel never offers a switch with nothing behind it. And what it writes back distinguishes ABSENT from
// OFF: a pin that says nothing about thinking sends nothing and the harness's own default answers, while one
// that says `false` turns it off, and the two must not collapse into each other on the way to the setting.
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

/* The model list itself is the app's own panel and has its own suite; here it is a stub that renders the footer
 * slot and can answer with a row, which is the same treatment the shell picker's test gives it. */
vi.mock(`../../../chat/ModelPicker.vue`, () => ({
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

// The chat's own pick is only the floor for an ADD, where there is no entry to read a provider off.
vi.mock(`../../../composables/chat/useChat`, () => ({ useChat: () => ({ provider: ref(`claude`), model: ref(`claude-haiku-4-5`) }) }));
// An empty live catalog puts every model on the static effort scale and publishes no `fast` badge, which is the
// state a fresh sandbox is in; the badge case gets its own catalog below.
const catalog = ref<Record<string, readonly { value: string; label: string; badges?: readonly string[]; efforts?: readonly string[] }[]>>({});
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
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
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
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

// Every row the footer drew, by the label it announces (the rows are label-left, control-right). Asserted
// whole rather than one row at a time, because what an entry is OFFERED is the claim.
const knobRows = (host: HTMLElement): string[] =>
    [...host.querySelectorAll<HTMLElement>(`div.flex.items-center.justify-between`)]
        .map((element) => element.querySelector(`span`)?.textContent?.trim() ?? ``)
        .filter((label) => label !== ``);

// A footer row by the label it announces, for reaching the controls inside it.
const row = (host: HTMLElement, label: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>(`div.flex.items-center.justify-between`)].find((element) =>
        element.querySelector(`span`)?.textContent?.trim().startsWith(label),
    );

const segment = (host: HTMLElement, label: string, option: string): HTMLButtonElement =>
    [...(row(host, label)?.querySelectorAll<HTMLButtonElement>(`button`) ?? [])].find((button) => button.textContent?.trim() === option)!;

test("a list whose entries carry no run settings gets the list and no footer at all", async () => {
    // The quick helpers are one-shot calls the daemon runs with thinking disabled and no effort, so a reasoning
    // control there would be a switch with nothing behind it.
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
    // Claude runs its own loop, so there is no harness to choose; fast speed needs the model's own catalog
    // badge, which this catalog does not publish.
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

    // …and back to standard drops the field rather than storing a false: absent is what the turn schema means
    // by standard speed.
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

/* THE TOP RUNG IS THE MODEL'S TO PUBLISH, and the entry's own thinking chip is the only thing that can take it
 * away again: `effort: max` with thinking DISABLED is a 400 that kills the turn before the model sees it. The
 * chip's Default position is not that pair — the turn goes out with no thinking field and the daemon names the
 * reasoning the tier needs (sendableThinking) — and collapsing the two is what hid Max behind a chip nobody had
 * touched. */
test("the top tier follows the entry's own thinking: only switching it off takes Max away", async () => {
    catalog.value = { claude: [{ value: `claude-opus-5`, label: `Claude Opus 5`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }] };
    const rungs = (host: HTMLElement): string[] =>
        [...(row(host, `Reasoning effort`)?.querySelectorAll<HTMLButtonElement>(`button[aria-label]`) ?? [])].map(
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

// …and a provider that published no scale is never GIVEN the top rung: its floor is the tiers every runtime
// accepts, and `max` is one a provider has to claim for itself (Claude's floor is the documented exception,
// pinned in effortScale's own suite).
test("an entry on a provider that published no scale gets a floor with no Max in it", async () => {
    const host = mount({ pin: { provider: `codex`, model: `gpt-5.6` }, knobs: true });
    await nextTick();

    expect(
        [...(row(host, `Reasoning effort`)?.querySelectorAll<HTMLButtonElement>(`button[aria-label]`) ?? [])].map((button) =>
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
    // Effort travels because every native scale has tiers and the meter clamps what a shorter one will run at.
    // The harness, thinking and speed are facts about the provider that vends the model, so carrying them
    // across a switch would pin the new entry to a knob its provider does not have.
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
    // Its own row stays pickable: a panel that refused the selection it opened on would look like it had lost it.
    expect(unpickable?.({ provider: `codex`, value: `gpt-5.6` })).toBe(false);
    expect(unpickable?.({ provider: `claude`, value: `claude-haiku-4-5` })).toBe(false);
});
