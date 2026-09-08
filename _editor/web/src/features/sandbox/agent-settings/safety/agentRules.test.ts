// @vitest-environment jsdom
// The four built-in switches on the Agent tab write and read ordinary rules in settings; toggling one must not
// touch the others, and "Test what the change did" writes a setting rather than a rule.
import type { Rule, SandboxSettings } from "@intentic/api-contract";
import { SandboxSettingsSchema } from "@intentic/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Needs jsdom: useDevice reads window.matchMedia and environment.ts reads window.env at import.

// The settings object every row reads and writes; patch is the seam, not the daemon round trip.
const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// The firings query is a separate route; it says nothing about what a row writes.
vi.mock(`../../client/useSandboxQuery`, () => ({
    useSandboxQuery: () => ({ query: { data: ref({}), isLoading: ref(false), error: ref(undefined) }, error: ref(undefined) }),
}));

const { default: AgentChecks } = await import("../behaviour/AgentChecks.vue");
const { default: AgentFinishedWork } = await import("../behaviour/AgentFinishedWork.vue");
const { useRules } = await import("../../environment/useRules");

let app: App | undefined;

const mount = (component: unknown): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(component as never) });
    // Icon/tooltip are stubbed; PrimeVue itself is still installed since inputs read its config at render.
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

const ruleById = (id: string): Rule | undefined => settings.value.rules.find((rule) => rule.id === id);

// Switches render as PrimeVue's own input; clicking it is the only path that proves the handler is wired.
const toggleAt = (host: HTMLElement, index: number): HTMLElement => {
    const switches = [...host.querySelectorAll(`[role="switch"], input[type="checkbox"]`)];
    const control = switches[index];
    expect(control, `expected a switch at index ${index}`).toEqual(expect.any(Object));
    return control as HTMLElement;
};

test(`"Verify before finishing" writes the proof-ledger rule at the turn-ending moment`, async () => {
    const host = mount(AgentChecks);
    expect(settings.value.rules).toEqual([]);

    toggleAt(host, 0).click();
    await Promise.resolve();

    const rule = ruleById(`verify-edits`);
    expect(rule?.moment).toBe(`turn.ending`);
    expect(rule?.action).toEqual({ kind: `builtin`, name: `verify-edits` });
    expect(rule?.enabled).toBe(true);
});

test(`"Check what it deleted" writes the removal-ledger rule beside it, not instead of it`, async () => {
    const host = mount(AgentChecks);

    toggleAt(host, 1).click();
    await Promise.resolve();

    expect(ruleById(`verify-removals`)?.moment).toBe(`turn.ending`);
    expect(ruleById(`verify-removals`)?.action).toEqual({ kind: `builtin`, name: `verify-removals` });
    expect(ruleById(`verify-edits`)).toBeUndefined();
});

test(`"Look at what it changed" writes the view-ledger rule beside the other two`, async () => {
    const host = mount(AgentChecks);

    toggleAt(host, 2).click();
    await Promise.resolve();

    expect(ruleById(`verify-ui-edits`)?.moment).toBe(`turn.ending`);
    expect(ruleById(`verify-ui-edits`)?.action).toEqual({ kind: `builtin`, name: `verify-ui-edits` });
    expect(ruleById(`verify-ui-edits`)?.enabled).toBe(true);
    expect(ruleById(`verify-edits`)).toBeUndefined();
    expect(ruleById(`verify-removals`)).toBeUndefined();
});

test(`"Check what it did to the tests" writes the tests rule beside the other three`, async () => {
    const host = mount(AgentChecks);

    toggleAt(host, 3).click();
    await Promise.resolve();

    expect(ruleById(`verify-tests`)?.moment).toBe(`turn.ending`);
    expect(ruleById(`verify-tests`)?.action).toEqual({ kind: `builtin`, name: `verify-tests` });
    expect(ruleById(`verify-tests`)?.enabled).toBe(true);
    expect(settings.value.rules).toHaveLength(1);
});

test(`switching it back off disables the rule rather than losing where the user put it`, async () => {
    // The second rule exists to confirm toggling doesn't reorder it.
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
    expect(input).toEqual(expect.any(HTMLElement));

    input.value = `pnpm test`;
    input.dispatchEvent(new Event(`input`));
    input.dispatchEvent(new Event(`change`));
    await Promise.resolve();

    expect(ruleById(`pre-push`)?.moment).toBe(`push.starting`);
    expect(ruleById(`pre-push`)?.action).toMatchObject({ kind: `command`, command: `pnpm test` });

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
    expect(ruleById(`auto-land`)).toBeUndefined();
});

test(`the general list shows every rule EXCEPT the four with a row of their own`, () => {
    settings.value = {
        ...settings.value,
        rules: [
            { id: `verify-edits`, label: `Verify`, moment: `turn.ending`, action: { kind: `builtin`, name: `verify-edits` }, enabled: true },
            { id: `verify-removals`, label: `Deleted`, moment: `turn.ending`, action: { kind: `builtin`, name: `verify-removals` }, enabled: true },
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
    // Composable-only: mounting a real list would test the row component, not the partition.
    app = createApp({ setup: () => () => h(`div`) });
    app.mount(document.createElement(`div`));
    expect(useRules().listed.value.map((rule) => rule.id)).toEqual([`changelog`]);
});

// Driven on defaults, a turn-ending instruct rule, covering the whole assembly path without opening the moment
// picker's overlay.
const typeInto = async (host: HTMLElement, label: string, value: string): Promise<void> => {
    // Matches an input or a textarea, since an instruction field renders as a textarea.
    const field = host.querySelector(`input[aria-label="${label}"], textarea[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
    expect(field, `expected a field labelled ${label}`).toEqual(expect.any(HTMLElement));
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await Promise.resolve();
};

const clickText = async (host: HTMLElement, text: string): Promise<void> => {
    const target = [...host.querySelectorAll(`button, [role="button"]`)].find((element) => element.textContent?.includes(text));
    expect(target, `expected something clickable saying "${text}"`).toEqual(expect.any(HTMLElement));
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
    // id is derived from the label; the activity feed and firing stamps are keyed by it.
    expect(rule?.id).toBe(`update-the-changelog`);
    expect(rule?.moment).toBe(`turn.ending`);
    expect(rule?.when).toEqual({ paths: [`docs/**`, `**/*.md`] });
    expect(rule?.action).toEqual({ kind: `instruct`, text: `Update the changelog before you finish.` });
});

test(`a rule left unnamed names itself from what it was told to do`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `What to tell the assistant`, `Update the changelog before you finish.`);
    await clickText(host, `Add rule`);

    const rule = settings.value.rules[0];
    // The trailing period is stripped: `label` is a name, not a copied sentence.
    expect(rule?.label).toBe(`Update the changelog before you finish`);
    expect(rule?.id).toBe(`update-the-changelog-before-you-finish`);
});

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

    expect(settings.value.rules.map((rule) => rule.id)).toEqual([`checks`, `checks-2`]);
});

test(`a form missing the field its action needs cannot be added, and says which field`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    const host = mount(AgentRules);

    await clickText(host, `Add a rule`);
    await typeInto(host, `Rule name`, `Says nothing`);
    const add = [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Add rule`));
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(settings.value.rules).toEqual([]);
});

// Editing must preserve what the form doesn't ask about: the id used by history and firings, and whether the rule
// was switched off.
test(`editing a rule rewrites its words and keeps its id and its switch`, async () => {
    const { default: AgentRules } = await import("./AgentRules.vue");
    settings.value = {
        ...settings.value,
        rules: [{ id: `changelog`, label: `Changelog`, moment: `turn.ending`, action: { kind: `instruct`, text: `old` }, enabled: false }],
    };
    const host = mount(AgentRules);

    // The row's menu teleports out of the component, so the item is found on the document.
    const actions = host.querySelector(`button[aria-label="Rule actions"]`) as HTMLButtonElement;
    expect(actions, `expected a row menu`).toEqual(expect.any(HTMLElement));
    actions.click();
    await Promise.resolve();
    const edit = [...document.body.querySelectorAll(`a`)].find((item) => item.textContent?.includes(`Edit`));
    expect(edit, `expected an Edit item`).toEqual(expect.any(HTMLElement));
    (edit as HTMLElement).click();
    await Promise.resolve();

    await typeInto(host, `What to tell the assistant`, `new words`);
    await clickText(host, `Save changes`);

    expect(settings.value.rules).toHaveLength(1);
    expect(settings.value.rules[0]?.id).toBe(`changelog`);
    expect(settings.value.rules[0]?.enabled).toBe(false);
    expect(settings.value.rules[0]?.action).toEqual({ kind: `instruct`, text: `new words` });
});
