// @vitest-environment jsdom
//
// THE SWITCH OVER THE SAFETY JUDGE, and the fact — not the control — of what it is running on. The switch did
// not exist while the judge did, which left the one tier of the safety design that spends money and interrupts
// people with nothing an owner could do about it: a gate asking about the wrong things could be answered by
// editing prose and hoping, and by nothing else.
//
// The MODEL is chosen on the Models tab now, not here. That is the claim half this file exists to hold: this
// group must keep naming which model is applying the policy, because somebody deciding whether to trust the
// document below has exactly that question about it — and it must not grow a second way to change it, because
// "where do I choose a model" having two answers is what moved the picker in the first place.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// Two connected accounts, so the row that names the fallback has a real chain to name: what this row must say
// while nothing is pinned is WHICH account the verdicts are billed to, not the word "Auto".
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../composables/chat/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

const { default: AgentSafetyJudge } = await import("./AgentSafetyJudge.vue");

// The group links back to the Models tab, so it needs a router to resolve one against. The hub's route alone:
// the app's own carries guards that have nothing to do with what is under test here.
const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
});
await router.push({ name: `sandbox`, params: { tab: `agent` }, query: { section: `safety` } });
await router.isReady();

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentSafetyJudge) });
    app.use(PrimeVue);
    app.use(router);
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
    connected.value = [`codex`, `claude`];
    patch.mockClear();
});

const pill = (host: HTMLElement, label: string): HTMLElement =>
    [...host.querySelectorAll<HTMLElement>(`button, [role="radio"], [role="tab"]`)].find((element) => element.textContent?.trim() === label)!;

// The default, read off the schema rather than transcribed: a workspace nobody has configured judges commands,
// which is what every other part of this design assumes.
test("opens on the setting's own default", () => {
    const host = mount();
    expect(SandboxSettingsSchema.parse({}).commandJudge).toBe(`on`);
    expect(host.textContent).toContain(`The verdict decides`);
});

test("moving the switch writes the mode and says what that mode does", async () => {
    const host = mount();
    pill(host, `Watch`).click();
    await nextTick();
    expect(patch).toHaveBeenCalledWith({ commandJudge: `watch` });
    expect(host.textContent).toContain(`nothing is ever held`);
});

/* THE PROMISE THE SWITCH MAY NOT BREAK. "Off" reads as switching the gate off entirely, which it is not: the
 * hard rule is typed rather than judged and no setting reaches it. If that stops being said on the same screen
 * as the switch, the Safety page is making a promise the settings quietly contradict. */
test("the states that stop holding commands say what still asks", async () => {
    const host = mount();
    expect(host.textContent).not.toContain(`still asks`);

    for (const mode of [`Off`, `Watch`]) {
        pill(host, mode).click();
        await nextTick();
        expect(host.textContent, mode).toContain(`still asks`);
        expect(host.textContent, mode).toContain(`/history`);
    }
});

/* WHICH MODEL IS APPLYING THE POLICY, which is the question this group answers about the model and the only one.
 * Named in full: a verdict is billed to one of these accounts, and reading a policy without knowing what reads
 * it back is the state this row exists to prevent. */

/* SWITCHED ON AND STILL INERT is a real state, and it is the state of every sandbox that has not been to the
 * Models tab: nothing is derived for a job with no models, so the judge runs on nothing and the standing rule
 * alone decides. A page about a safety policy owes that sentence more than any other on it, and the failure it
 * guards against is silent — the group would look configured while nothing read the document below. */
test("says the judge has no model rather than naming one nobody chose", () => {
    const host = mount();
    // Read off the schema rather than transcribed: the role ships with no list.
    expect(SandboxSettingsSchema.parse({}).modelRoles[`safety-judge`]).toBeUndefined();
    expect(host.textContent).toContain(`No model is set for the judge`);
    expect(host.textContent).toContain(`standing rule alone`);
    // Two accounts are connected, and neither may be named: the row's job is what the owner set, not what this
    // app would have reached for.
    expect(host.textContent).not.toContain(`Judged by`);
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
});

test("a model pinned on the Models tab is the one this row names", async () => {
    settings.value = { ...settings.value, modelRoles: { "safety-judge": [{ provider: `codex`, model: `gpt-5.6` }] } };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`Judged by`);
    expect(host.textContent).toContain(`CODEX · GPT 5.6 Luna`);
    // The pin replaces the chain rather than joining it: what runs is the list the owner wrote, and naming the
    // fallback beside it would read as two models judging one command.
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
});

/* THE ROLE IS THE JUDGE'S OWN, not a list it shares with the rest of the automatic jobs. It used to fall back to
 * one "quick model" chain covering commit messages and session titles too, so an owner who wanted a stronger
 * model reading commands had to move all three. Pinning one job must leave the others alone, and this row must
 * name the job's own answer. */
test("reads the safety-judge list rather than another job's", async () => {
    settings.value = { ...settings.value, modelRoles: { "commit-message": [{ provider: `codex`, model: `gpt-5.6` }] } };
    const host = mount();
    await nextTick();

    // Commit messages are set to Codex; the judge has nothing, and a row reading the wrong key would name the
    // other job's model here.
    expect(host.textContent).toContain(`No model is set for the judge`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
});

// Nothing to point a model at: the row says the model is not in use rather than naming one that never runs.
test("names no model in use while the judge is off", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain(`no model is in use`);
    expect(host.textContent).not.toContain(`Judged by`);
});

/* THE PICKER IS NOT HERE, and that is a claim rather than an absence: this group used to hold the whole four
 * gesture list editor, and putting one back would restore the split it was moved to end. The row offers exactly
 * one press, and it goes to the tab that owns every model in the sandbox. */
test("offers no way to edit the model, only the address of the one that does", () => {
    const host = mount();

    expect(host.querySelector(`ol li`)).toBeNull();
    expect([...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`))).not.toContain(
        `Add a model for the safety judge`,
    );

    const link = host.querySelector<HTMLAnchorElement>(`a[href]`);
    expect(link?.textContent?.trim()).toBe(`Change in Models`);
    // The Models category is the tab's default, so its address carries no section param at all.
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent`);
});
