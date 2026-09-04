// @vitest-environment jsdom
//
// DELEGATION AS ONE GROUP: whether the assistant may hand work to agents of its own, and then how far. The
// posture arrived here from a group of its own on the Safety tab ("Child agents"), which filed a spending
// ceiling under the gate that decides whether a command may delete your files, and left one concept under two
// names on two screens.
//
// What the move actually risks is the posture's storage, which is unlike every other row on this page: the three
// ceilings are plain numbers on their own keys, while the posture is one entry in `actionRules` — an OPEN record
// that also holds the outbound sniffer's `<provider>.<type>` rules. Writing it as if it owned that object would
// silently delete every send rule the owner has, and nothing on screen would say so. That is the claim this file
// exists to hold.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { postureOf, POSTURES, SPAWN_KEY, withPosture } from "./spawnPosture";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

const { default: AgentSubagents } = await import("./AgentSubagents.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSubagents) });
    app.use(PrimeVue);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
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

// The posture's own trigger, which opens a list rather than taking a value: reached by what it announces, not
// by position, because it is the only control in the group that is not a number box.
const postureTrigger = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>(`[aria-label="Start agents of its own"]`)!;

/* WHETHER AND HOW MANY ARE ONE GROUP. Pinned as membership rather than as a screenshot: the whole point of the
 * merge is that an owner who turns the ceilings down finds the switch that turns the feature off in the same
 * place, and a group that quietly lost one half again would still render four healthy-looking rows. */
test("draws the posture and all three ceilings together", () => {
    const host = mount();

    expect(postureTrigger(host)).not.toBeNull();
    for (const label of [`Subagents at once`, `Subagents per conversation`, `Nesting depth`]) {
        expect(numberBox(host, label), label).not.toBeNull();
    }
});

// The defaults are read off the schema rather than transcribed: these are the Claude Code CLI's own numbers, and
// a copy here would go stale the day the daemon changes one.
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

/* THE POSTURE'S STORAGE, which is the one thing the move could have broken, and it is checked against the
 * function rather than through the picker: <Picker> opens a measured overlay, so driving it here would test the
 * design system's placement code and not the merge that can eat somebody's rules. */

test("writing the posture keeps every other action rule", () => {
    // `actionRules` is shared with the outbound sniffer, whose keys this row has never heard of.
    expect(withPosture({ "slack.message": `hold` }, `deny`)).toEqual({ "slack.message": `hold`, "agents.spawn": `deny` });
});

/* DEFAULT IS NOT ALLOW, and the difference is the whole reason it is one of the four postures rather than the
 * absence of a choice: an unset key holds a spawn from a turn that has taken in outside content, so returning to
 * Default has to DELETE the key rather than write one spelling out the fallback. */
test("returning to Default removes the rule instead of writing one", () => {
    const rules = withPosture({ "agents.spawn": `deny`, "slack.message": `hold` }, `default`);

    expect(rules).toEqual({ "slack.message": `hold` });
    expect(SPAWN_KEY in rules).toBe(false);
});

test("an absent rule reads back as Default, not as allow", () => {
    expect(postureOf({})).toBe(`default`);
    expect(postureOf({ "agents.spawn": `allow` })).toBe(`allow`);
});

/* FOUR POSTURES, NOT A TOGGLE. This is the claim the repository's own history defends and the one nothing
 * covered: every test above keeps passing if the picker is "simplified" into an on/off switch, because the merge
 * and the read-back would both still work on the two values a boolean leaves.
 *
 * Two of the four are what such a tidy-up would cost. `hold` is the only answer that lets a spawn happen with
 * the owner in the loop rather than choosing for them in advance, and `default` is NOT `allow`: an unset key
 * holds a spawn from a turn that has taken in outside content, so a boolean's "on" would silently switch that
 * protection off for everyone who had never touched the control.
 *
 * Held against the exported list rather than the rendered row on purpose: <Picker> draws its options into a
 * measured overlay that jsdom never opens, so an assertion on the markup would pass an empty list. */
test("offers exactly the four postures, and Default is one of them", () => {
    expect(POSTURES.map((option) => option.value)).toEqual([`default`, `allow`, `hold`, `deny`]);
});

// Default leads, because reading down is meant to run from "whatever the sandbox decides" to the three answers
// that overrule it, and because the option a reader lands on first should be the one already in force.
test("puts Default first and says what it actually does", () => {
    const fallback = POSTURES[0];

    expect(fallback?.value).toBe(`default`);
    // The prompt-injection nuance that used to justify filing this control under Safety lives here now: it is a
    // property of this one option, and the row has no other way to say so.
    expect(fallback?.description).toContain(`outside content`);
});

// Every posture the picker offers has to be one the write can store, and every stored value one the picker can
// draw: a label with no rule behind it is a control that silently does nothing.
test("every posture round-trips through the write", () => {
    for (const option of POSTURES) {
        const rules = withPosture({}, option.value);
        expect(postureOf(rules), option.value).toBe(option.value);
    }
});

// The write does not mutate what it was handed: settings are a shared reactive object, and a patch that edited
// it in place would leave the optimistic cache already holding the new value if the save were refused.
test("leaves the rules it was given alone", () => {
    const before = { "agents.spawn": `hold` } as const;
    withPosture(before, `deny`);

    expect(before).toEqual({ "agents.spawn": `hold` });
});

// A refused feature with three live number boxes under it invites an owner to tune a limit on work that will
// never start, so the group says so instead of leaving them to find out.
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
