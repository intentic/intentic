// @vitest-environment jsdom
//
// THE ONE CLAIM THIS WHOLE GROUP RESTS ON: the three rows with their own place on the Agent tab are ORDINARY
// RULES, not switches sitting beside a table that happens to agree with them. If that is true then a toggle and
// the list below it can never disagree, and a user who outgrows a row can read back exactly what it wrote.
//
// It is only true if each row writes the rule it claims to. Mounted rather than projected because what is under
// test is the round trip a person actually performs — press the switch, read what the settings object now holds
// — and the write happens in the component's own handler.
import type { Rule, SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// These components' import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env).

// The settings object every row reads and writes. `patch` is the seam: the daemon round-trip is somebody else's
// test, and what matters here is the shape that would have been sent.
const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// The firings read is a second daemon route and says nothing about what a row writes.
vi.mock(`../../../composables/sandbox/useSandboxQuery`, () => ({
    useSandboxQuery: () => ({ query: { data: ref({}), isLoading: ref(false), error: ref(undefined) }, error: ref(undefined) }),
}));

const { default: AgentChecks } = await import("./AgentChecks.vue");
const { default: AgentFinishedWork } = await import("./AgentFinishedWork.vue");
const { useRules } = await import("../../../composables/sandbox/useRules");

let app: App | undefined;

const mount = (component: unknown): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(component as never) });
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin
    // (the PlanLimitsPanel test's convention). PrimeVue itself cannot be stood in for — its inputs and buttons
    // read the injected config while rendering — so the plugin goes on bare, without the theme the app dresses
    // it in, which is styling this test has no opinion about.
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

const ruleById = (id: string): Rule | undefined => settings.value.rules.find((rule) => rule.id === id);

// The switches are PrimeVue ToggleSwitch, which renders its own input; clicking the rendered control is what a
// person does and is the only path that proves the handler is wired to it.
const toggleAt = (host: HTMLElement, index: number): HTMLElement => {
    const switches = [...host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)];
    const control = switches[index];
    expect(control, `expected a switch at index ${index}`).toBeDefined();
    return control as HTMLElement;
};

test(`"Verify before finishing" writes the proof-ledger rule at the turn-ending moment`, async () => {
    const host = mount(AgentChecks);
    expect(settings.value.rules).toEqual([]);

    toggleAt(host, 0).click();
    await Promise.resolve();

    const rule = ruleById(`verify-edits`);
    expect(rule?.moment).toBe(`turn.ending`);
    // A built-in, because what it does is not a command and could not be written as one.
    expect(rule?.action).toEqual({ kind: `builtin`, name: `verify-edits` });
    expect(rule?.enabled).toBe(true);
});

test(`switching it back off disables the rule rather than losing where the user put it`, async () => {
    // Position is priority at a deciding moment, so a row that deleted and re-appended its rule could silently
    // move it below one the user had deliberately placed above.
    settings.value = {
        ...settings.value,
        rules: [
            {
                id: `verify-edits`,
                label: `Verify before finishing`,
                moment: `turn.ending`,
                action: { kind: `builtin`, name: `verify-edits` },
                enabled: true,
            },
            { id: `later`, label: `Later`, moment: `turn.ending`, action: { kind: `instruct`, text: `x` }, enabled: true },
        ],
    };
    const host = mount(AgentChecks);

    toggleAt(host, 0).click();
    await Promise.resolve();

    expect(ruleById(`verify-edits`)?.enabled).toBe(false);
    expect(settings.value.rules.map((rule) => rule.id)).toEqual([`verify-edits`, `later`]);
});

test(`the pre-push command box writes a command rule, and emptying it takes the rule away`, async () => {
    const host = mount(AgentChecks);
    const input = host.querySelector(`input[aria-label="Pre-push check command"]`) as HTMLInputElement;
    expect(input).toBeTruthy();

    input.value = `pnpm test`;
    input.dispatchEvent(new Event(`input`));
    input.dispatchEvent(new Event(`change`));
    await Promise.resolve();

    expect(ruleById(`pre-push`)?.moment).toBe(`push.starting`);
    expect(ruleById(`pre-push`)?.action).toMatchObject({ kind: `command`, command: `pnpm test` });

    // Empty has always meant OFF for this row, and off is no rule at all — a disabled rule with a blank command
    // would sit in the list below as something nobody wrote on purpose.
    input.value = `   `;
    input.dispatchEvent(new Event(`input`));
    input.dispatchEvent(new Event(`change`));
    await Promise.resolve();

    expect(ruleById(`pre-push`)).toBeUndefined();
});

test(`"Land finished work automatically" writes an allow VERDICT, and off writes nothing at all`, async () => {
    const host = mount(AgentFinishedWork);

    toggleAt(host, 0).click();
    await Promise.resolve();
    expect(ruleById(`auto-land`)?.action).toEqual({ kind: `verdict`, verdict: `allow` });

    toggleAt(host, 0).click();
    await Promise.resolve();
    // Not a "hold" rule: an empty table already means held, and a rule restating the default would be one more
    // line in the list that changes nothing.
    expect(ruleById(`auto-land`)).toBeUndefined();
});

test(`the general list shows every rule EXCEPT the three with a row of their own`, () => {
    settings.value = {
        ...settings.value,
        rules: [
            { id: `verify-edits`, label: `Verify`, moment: `turn.ending`, action: { kind: `builtin`, name: `verify-edits` }, enabled: true },
            {
                id: `pre-push`,
                label: `Pre-push`,
                moment: `push.starting`,
                action: { kind: `command`, command: `x`, timeoutMs: 900_000 },
                enabled: true,
            },
            { id: `auto-land`, label: `Land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` }, enabled: true },
            { id: `changelog`, label: `Changelog`, moment: `turn.ending`, action: { kind: `instruct`, text: `Update it.` }, enabled: true },
        ],
    };
    // Composable-only: what is under test is the partition, and mounting a list to count its rows would test
    // the row component instead.
    app = createApp({ setup: () => () => h(`div`) });
    app.mount(document.createElement(`div`));
    expect(useRules().listed.value.map((rule) => rule.id)).toEqual([`changelog`]);
});

/* --- the add flow -------------------------------------------------------------------------------------------
 * Driven on its DEFAULTS (a turn-ending rule that tells the assistant something), which covers the whole
 * assembly path — words to a rule, optional paths to a condition, choice to an action — without reaching into
 * the moment picker's overlay. The moment/action pairing those controls enforce is pinned where it is decided,
 * in the daemon's own schema. */
const typeInto = async (host: HTMLElement, label: string, value: string): Promise<void> => {
    // Textarea as well as input: what you tell the assistant is a paragraph, and the form types it in one.
    const field = host.querySelector(`input[aria-label="${label}"], textarea[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
    expect(field, `expected a field labelled ${label}`).toBeTruthy();
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await Promise.resolve();
};

const clickText = async (host: HTMLElement, text: string): Promise<void> => {
    const target = [...host.querySelectorAll(`button, [role="button"]`)].find((element) => element.textContent?.includes(text));
    expect(target, `expected something clickable saying "${text}"`).toBeTruthy();
    (target as HTMLElement).click();
    await Promise.resolve();
};

test(`the add flow turns a filled form into a rule, id and all`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `Rule name`, `Update the changelog`);
    await clickText(host, `Only when it touches`);
    await typeInto(host, `Paths`, `docs/**, **/*.md`);
    await typeInto(host, `What to tell the assistant`, `Update the changelog before you finish.`);
    await clickText(host, `Add rule`);

    const rule = settings.value.rules[0];
    // The id is derived from the label, so the add flow never asks for one — it is what the activity feed names
    // and what the firing stamps are keyed by.
    expect(rule?.id).toBe(`update-the-changelog`);
    expect(rule?.moment).toBe(`turn.ending`);
    expect(rule?.when).toEqual({ paths: [`docs/**`, `**/*.md`] });
    expect(rule?.action).toEqual({ kind: `instruct`, text: `Update the changelog before you finish.` });
});

// THE FORM NO LONGER ASKS FOR A NAME BEFORE THERE IS ANYTHING TO NAME. Leaving the box alone has to produce a
// rule the list and the activity feed can both use, or the field is back to being required in everything but
// the error message.
test(`a rule left unnamed names itself from what it was told to do`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `What to tell the assistant`, `Update the changelog before you finish.`);
    await clickText(host, `Add rule`);

    const rule = settings.value.rules[0];
    // Without the full stop: it is a name now, not a sentence.
    expect(rule?.label).toBe(`Update the changelog before you finish`);
    expect(rule?.id).toBe(`update-the-changelog-before-you-finish`);
});

// Both separators, because both are how people write a list of globs — and a space-separated pair used to
// become ONE glob that matched nothing, silently.
test(`paths typed with commas or spaces both arrive as separate globs`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await clickText(host, `Only when it touches`);
    await typeInto(host, `Paths`, `docs/** src/**,api/**`);
    await typeInto(host, `What to tell the assistant`, `Say something`);
    await clickText(host, `Add rule`);

    expect(settings.value.rules[0]?.when).toEqual({ paths: [`docs/**`, `src/**`, `api/**`] });
});

test(`a second rule with the same name gets its own id rather than overwriting the first`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    settings.value = {
        ...settings.value,
        rules: [{ id: `checks`, label: `Checks`, moment: `turn.ending`, action: { kind: `instruct`, text: `first` }, enabled: true }],
    };
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `Rule name`, `Checks`);
    await typeInto(host, `What to tell the assistant`, `second`);
    await clickText(host, `Add rule`);

    // A collision would quietly merge two rules' firing histories and give the feed one name for two things.
    expect(settings.value.rules.map((rule) => rule.id)).toEqual([`checks`, `checks-2`]);
});

test(`a form missing the field its action needs cannot be added, and says which field`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `Rule name`, `Says nothing`);
    const add = [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add rule`));
    expect((add as HTMLButtonElement).disabled).toBe(true);
    // A disabled button explains nothing on its own, so the reason stands beside it.
    expect(host.textContent).toContain(`Type what to tell the assistant.`);
    expect(settings.value.rules).toEqual([]);
});

/* --- editing -------------------------------------------------------------------------------------------------
 * The capability the old form did not have: changing a rule meant deleting it and typing all of it again. What
 * has to survive the round trip is everything the form does not ask about — the id the activity feed and the
 * firing stamps are keyed by, and whether the owner had switched the rule off. */
test(`editing a rule rewrites its words and keeps its id and its switch`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    settings.value = {
        ...settings.value,
        rules: [{ id: `changelog`, label: `Changelog`, moment: `turn.ending`, action: { kind: `instruct`, text: `old` }, enabled: false }],
    };
    const host = mount(AgentRules);

    // The row's menu teleports out of the component, so the item is found on the document.
    const actions = host.querySelector(`button[aria-label="Rule actions"]`) as HTMLButtonElement;
    expect(actions, `expected a row menu`).toBeTruthy();
    actions.click();
    await Promise.resolve();
    const edit = [...document.body.querySelectorAll(`a`)].find((item) => item.textContent?.includes(`Edit`));
    expect(edit, `expected an Edit item`).toBeTruthy();
    (edit as HTMLElement).click();
    await Promise.resolve();

    await typeInto(host, `What to tell the assistant`, `new words`);
    await clickText(host, `Save changes`);

    expect(settings.value.rules).toHaveLength(1);
    expect(settings.value.rules[0]?.id).toBe(`changelog`);
    expect(settings.value.rules[0]?.enabled).toBe(false);
    expect(settings.value.rules[0]?.action).toEqual({ kind: `instruct`, text: `new words` });
});
