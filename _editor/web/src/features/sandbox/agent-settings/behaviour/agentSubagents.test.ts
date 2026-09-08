// @vitest-environment jsdom
// Pins that the posture (`agents.spawn`) writes into the shared `actionRules` record without clobbering other
// keys (e.g. the outbound sniffer's `<provider>.<type>` rules), unlike the three plain-number ceilings beside it.
import type { SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { postureOf, POSTURES, SPAWN_KEY, withPosture } from "../safety/spawnPosture";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

const { default: AgentSubagents } = await import("./AgentSubagents.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSubagents) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    patch.mockClear();
});

const numberBox = (host: HTMLElement, label: string): HTMLInputElement =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

// Reached by its aria-label, not `numberBox`: the posture control isn't a number input.
const postureTrigger = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>(`[aria-label="Start agents of its own"]`)!;

test("draws the posture and all three ceilings together", () => {
    const host = mount();

    expect(postureTrigger(host)).not.toBeNull();
    for (const label of [`Subagents at once`, `Subagents per conversation`, `Nesting depth`]) {
        expect(numberBox(host, label), label).not.toBeNull();
    }
});

test("each ceiling opens on the daemon's own default", () => {
    const host = mount();
    const defaults = SandboxSettingsSchema.parse({});

    expect(numberBox(host, `Subagents at once`).value).toBe(String(defaults.subagentsAtOnce));
    expect(numberBox(host, `Subagents per conversation`).value).toBe(String(defaults.subagentsPerTurn));
    expect(numberBox(host, `Nesting depth`).value).toBe(String(defaults.subagentDepth));
});

test("a ceiling writes its own key and nothing else", async () => {
    const host = mount();
    const box = numberBox(host, `Subagents at once`);
    box.value = `5`;
    box.dispatchEvent(new Event(`change`));
    await nextTick();

    expect(patch).toHaveBeenCalledWith({ subagentsAtOnce: 5 });
});

// Checked directly against `withPosture`, not through <Picker>: jsdom never opens the overlay to click through.

test("writing the posture keeps every other action rule", () => {
    // `slack.message` stands in for the outbound sniffer's own keys, sharing the same `actionRules` record.
    expect(withPosture({ "slack.message": `hold` }, `deny`)).toEqual({ "slack.message": `hold`, "agents.spawn": `deny` });
});

test("returning to Default removes the rule instead of writing one", () => {
    const rules = withPosture({ "agents.spawn": `deny`, "slack.message": `hold` }, `default`);

    expect(rules).toEqual({ "slack.message": `hold` });
    expect(SPAWN_KEY in rules).toBe(false);
});

test("an absent rule reads back as Default, not as allow", () => {
    expect(postureOf({})).toBe(`default`);
    expect(postureOf({ "agents.spawn": `allow` })).toBe(`allow`);
});

// Checked against the exported `POSTURES` list, not the rendered row: <Picker> draws options into an overlay
// jsdom never opens.
test("offers exactly the four postures, and Default is one of them", () => {
    expect(POSTURES.map((option) => option.value)).toEqual([`default`, `allow`, `hold`, `deny`]);
});

test("puts Default first and says what it actually does", () => {
    const fallback = POSTURES[0];

    expect(fallback?.value).toBe(`default`);
    // Guards that the outside-content nuance is described on this option, not filed elsewhere.
    expect(fallback?.description).toContain(`outside content`);
});

test("every posture round-trips through the write", () => {
    for (const option of POSTURES) {
        const rules = withPosture({}, option.value);
        expect(postureOf(rules), option.value).toBe(option.value);
    }
});

test("leaves the rules it was given alone", () => {
    const before = { "agents.spawn": `hold` } as const;
    withPosture(before, `deny`);

    expect(before).toEqual({ "agents.spawn": `hold` });
});

test("says the ceilings bound nothing while delegation is refused", async () => {
    settings.value = { ...settings.value, actionRules: { "agents.spawn": `deny` } };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`bound nothing`);
});

test("says nothing of the kind while delegation runs", async () => {
    const host = mount();
    await nextTick();

    expect(settings.value.actionRules[`agents.spawn`]).toBeUndefined();
    expect(host.textContent).not.toContain(`bound nothing`);
});
