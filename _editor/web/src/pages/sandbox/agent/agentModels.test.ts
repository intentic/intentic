// @vitest-environment jsdom
//
// THE MODEL ROWS ARE AN ORDER, and the claim under test is that what is on screen IS the order the daemon
// will walk: same list, same sequence, written straight back to the setting. A row that drew a list it did not
// write would be the worst possible version of this feature: the user reads "GPT, then Haiku", the sandbox
// spends something else, and nothing on either side says so.
//
// And, since each entry carries its own run settings, the second claim: a knob moved on one entry lands on THAT
// entry. The effort used to be a single field beside the list, so there was nothing to get wrong here and
// nothing to test; now there is.
//
// THE THIRD CLAIM IS WHAT THE PAGE WAS REBUILT FOR: there is one list per JOB, and a row writes ITS job's list
// and no other. The page used to hold a "quick model" covering commit messages, session titles and loop
// verdicts at once, so pinning a better model for commit subjects moved all three; a row that still wrote a
// shared key would put that back without anybody noticing, because the screen would look identical.
//
// Mounted rather than projected because what is under test is the round trip a person performs: add a model,
// move it up, take it out, re-point one, change its tier, and each of those happens in the component's own
// handler.
import type { SandboxSettings } from "@intentic-app/api-contract";
import { MODEL_ROLE_BLOCKS, MODEL_ROLES, type ModelPin } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

// Same import-time browser globals the sibling suite stands in for (@intentic/ui's useDevice reads
// window.matchMedia; environment.ts reads window.env).

/* THE THREE ROLES THESE TESTS DRIVE, one per property being pinned: an ordinary one-shot (`commit-message`),
 * the one-shot with a switch of its own somewhere else (`safety-judge`), and a whole session whose floor is
 * the composer (`pipeline-fix`). Every other row on the page is one of these three shapes, drawn from the same
 * catalog by the same code. */
const COMMIT = `commit-message` as const;
const JUDGE = `safety-judge` as const;
const RUN = `pipeline-fix` as const;

const entry = (provider: string, model: string, rest: Record<string, unknown> = {}): ModelPin => ({ provider, model, ...rest }) as ModelPin;

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

vi.mock(`../../../composables/sandbox/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

// The tier readout's data source, a fixture like the settings above: what is under test is what the row SAYS
// over a given report, never the fetch behind it.
const savings = ref<{
    tier?: { judged: number; fast: number; atStakeUsd: number; routed: number; routedUsd: number; escalated: number; denied: number };
}>({});
vi.mock(`../../../composables/sandbox/useSavings`, () => ({
    useSavings: () => ({ savings, isLoading: ref(false), refetch: vi.fn(), error: ref(undefined) }),
}));

// Two connected accounts and one that is not: the whole point of these rows is which of them a click spends, so
// the catalog they read is the fixture, not a detail.
const CATALOGS: Record<string, readonly { value: string; label: string }[]> = {
    codex: [{ value: `gpt-5.6`, label: `GPT 5.6 Luna` }],
    claude: [{ value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` }],
    gemini: [{ value: `gemini-3-flash-lite`, label: `Gemini 3 Flash Lite` }],
};
const connected = ref<readonly string[]>([`codex`, `claude`]);

vi.mock(`../../../composables/chat/access`, () => ({ providerReady: (provider: string) => connected.value.includes(provider) }));
// `providerModels` empty rather than absent: the real effortScale runs against it, and an empty live catalog is
// what puts a model on the static scale, which is the case every fixture here is on.
vi.mock(`../../../composables/chat/providerCatalog`, () => ({
    endpointProviders: ref([]),
    providerModels: ref({}),
    modelOptionsFor: (provider: string) => CATALOGS[provider] ?? [],
    providerDisplayLabel: (provider: string) => provider.toUpperCase(),
}));

/* THE PICKER IS THE PAGE'S ONE PANEL, standing by and opened over whichever trigger raised it. Stubbed here
 * rather than mounted: behind the real one is the app's whole model catalog, and what these tests are about is
 * the wiring between a row and the list it writes — which entry the panel was opened over, and where its
 * answers land. The props are handed over LIVE (the reactive object, not a copy), so a test can watch an entry
 * change under the open panel the way the user does. */
let opened: { readonly pin?: unknown; readonly knobs?: boolean; readonly taken?: unknown } | undefined;
let answer: { pick: (pin: unknown) => void; configure: (pin: unknown) => void } | undefined;
vi.mock(`./ModelPinPicker.vue`, () => ({
    // `__esModule` so the SFC interop reads `.default` off this the way it would off the real component.
    __esModule: true,
    default: defineComponent({
        props: { open: Boolean, anchor: Object, pin: Object, knobs: Boolean, taken: Array },
        emits: [`update:open`, `pick`, `configure`],
        setup(props, { emit }) {
            opened = props;
            answer = { pick: (pin) => emit(`pick`, pin), configure: (pin) => emit(`configure`, pin) };
            return () => h(`div`, { class: `pin-picker` });
        },
    }),
}));

const { default: AgentModels } = await import("./AgentModels.vue");

// The safety-judge row links to the Safety tab when the judge is switched off, so the page needs a router to
// resolve that against. The hub's route alone: the app's own carries guards irrelevant to these rows.
const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: `/sandbox/:tab?`, name: `sandbox`, component: defineComponent({ render: () => h(`div`) }) }],
});
await router.push({ name: `sandbox`, params: { tab: `agent` } });
await router.isReady();

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentModels) });
    app.use(PrimeVue);
    app.use(router);
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

// The picker is an async import, so it lands a tick after the click that opened it: the module resolves, then
// Vue renders what it resolved to.
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    connected.value = [`codex`, `claude`];
    savings.value = {};
    opened = undefined;
    answer = undefined;
    patch.mockClear();
});

// The order as a person reads it off the screen: one entry per row, in the order the rows are drawn.
const orderOnScreen = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`ol li`)].map((row) => row.querySelector(`span.flex-1`)?.textContent?.trim() ?? ``).filter((text) => text !== ``);

// A row's controls by what they announce, not by their position: the row's own label is a button too (it opens
// the picker), so "the first button in the row" stopped being a stable way to reach the promote arrow.
const rowButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`ol li button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

const addButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.getAttribute(`aria-label`) === label)!;

/* WHAT EVERY JOB ROW SAYS BESIDE ITS NAME, as {job: chip}. Both halves live in the row's TITLE — the name, then
 * the state chip when the row has one — which is the arrangement under test as much as the words are: a chip
 * that drifted out of the title and into the trailing cluster would still read on screen and would no longer be
 * "next to the job name", which is the whole of why it is a chip rather than the paragraph it replaced.
 *
 * Read structurally rather than as text, because the two are adjacent with no whitespace between them: joined
 * into one string, `Commit messagesoff` is one prettier line-break away from being `Commit messages off`. */
const chips = (host: HTMLElement): Record<string, string> =>
    Object.fromEntries(
        [...host.querySelectorAll(`[class*="font-medium"] > span`)].map((title) => [
            title.firstElementChild?.textContent?.trim() ?? ``,
            title.childElementCount > 1 ? (title.lastElementChild?.textContent?.trim() ?? ``) : ``,
        ]),
    );

// What an empty list means for THIS job, which is the only reason the chip carries a word: a one-shot with no
// models does not run, a whole session with none opens on the model the owner picked for their own chat.
const unsetChip = (kind: string): string => (kind === `helper` ? `off` : `chat default`);

/* ONE ROW PER JOB, FROM THE CATALOG. The page is built by walking `MODEL_ROLES`, so this is the claim that a
 * job added to that table becomes configurable by existing rather than by somebody remembering to add a row —
 * which is what the four hand-written rows this replaced could not promise, and how a documentation sweep came
 * to share a tier with a red production pipeline. */
test("draws a row per declared role, plus the one setting that is not a role", async () => {
    const host = mount();
    await Promise.resolve();

    const named = chips(host);
    for (const role of MODEL_ROLES) {
        expect(Object.keys(named), role.id).toContain(role.label);
    }
    // The cheaper-tier row belongs to automatic tier selection rather than to a job, so it is drawn by hand and
    // must still be there. It is not a job, so it carries no tick and no chip — hence no title span to find it by.
    expect(host.textContent).toContain(`Automatic tier`);
    // Every job offers the same gesture, which is what makes the page one page rather than eighteen designs.
    const adders = [...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`));
    for (const role of MODEL_ROLES) {
        expect(adders, role.id).toContain(`Add a model for ${role.label.toLowerCase()}`);
    }
});

/* THE PAGE IS FOUR GROUPS, AND THE CATALOG DECIDES WHICH ROW IS IN WHICH. Eighteen rows on one surface was a
 * table rather than a page, and the fix is only worth anything if the blocks are the ones the catalog declares:
 * a role drawn under the wrong heading tells an owner that a session nobody is watching is one they start,
 * which is exactly the budget question the split exists to let them answer. Asserted per section rather than by
 * counting headings, because the failure that matters is a row in the wrong group, not a missing title. */
test("draws one group per declared block, in order, holding exactly that block's rows", async () => {
    const host = mount();
    await Promise.resolve();

    const sections = [...host.querySelectorAll(`section`)];
    for (const [index, block] of MODEL_ROLE_BLOCKS.entries()) {
        const section = sections[index];
        // The heading and the line under it are the block's own words, so a group cannot end up describing a
        // set of rows it no longer holds.
        expect(section?.textContent, block.id).toContain(block.label);
        expect(section?.textContent, block.id).toContain(block.caption);

        const adders = [...(section?.querySelectorAll(`button`) ?? [])]
            .map((button) => button.getAttribute(`aria-label`) ?? ``)
            .filter((label) => label.startsWith(`Add a model for`));
        expect(adders, block.id).toEqual(block.roles.map((role) => `Add a model for ${role.label.toLowerCase()}`));
    }

    // …and the one setting that is not a job gets a surface of its own, after them: it is the only thing here
    // that can override a model the user chose a second ago.
    expect(sections).toHaveLength(MODEL_ROLE_BLOCKS.length + 1);
    expect(sections.at(-1)?.textContent).toContain(`Automatic tier`);
});

/* ONE MARK IN THE LEAD COLUMN. The glyph and the tick used to sit side by side, an identity and an affordance
 * undermining each other, and the fix is that they share one slot: the glyph at rest, the box under the pointer
 * and on focus. What can be checked without a pointer is the structure that makes it possible — that the two
 * are in the same box rather than laid out as two — because a refactor that pulled the tick back into its own
 * column would restore the double mark while every other test on this page kept passing. */
test("a job's glyph and its tick share one slot", async () => {
    const host = mount();
    await Promise.resolve();

    // PrimeVue draws the box as a wrapper around the real input; the slot is that wrapper's parent.
    const slot = tickBox(host, `Select commit messages`).closest(`.p-checkbox`)?.parentElement;

    expect(slot?.querySelector(`i`)).not.toBeNull();
    // The tick is never merely hidden: opacity keeps it in the tab order and in the accessibility tree, so a
    // keyboard can find the control a pointer would otherwise have to reveal.
    expect(slot?.querySelector(`.p-checkbox`)?.classList.contains(`hidden`)).toBe(false);
});

/* THE READING ORDER, WHICH THE PAGE ARGUES FOR AND NOTHING ENFORCED. Its own comment states the rule: read
 * down and the REACH grows — from jobs nobody picked a model for, to whole sessions somebody's click started,
 * to the conversation in front of you. Automatic tier is last because it is the only setting here that can
 * override a model the user chose a second ago, and a settings page owes that ordering.
 *
 * That argument survived several rewrites of this page as prose alone, which is how it came to be defended by a
 * sentence that had to be re-checked by hand every time a row moved. Three orderings, asserted:
 *
 *   - every one-shot helper comes before every whole session (a job nobody picked a model for is read first),
 *   - both come before Automatic tier (the only one that reaches into a choice already made),
 *   - and the roles hold the catalog's own order, so the page and the table cannot drift apart. */
test("reads in order of reach: one-shots, then whole sessions, then the row that can override a live choice", async () => {
    const host = mount();
    await Promise.resolve();

    /* READ OFF THE ADD BUTTONS rather than off the headings: every row on this page has exactly one, its label
     * is already a public fact (the test above pins it), and a title is a bare `div` here that no stable
     * selector separates from the sub-headings inside a row. Document order of the buttons IS row order. */
    const adders = [...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`) ?? ``);
    const at = (label: string): number => adders.indexOf(label);
    const roleAt = (kind: string): number[] =>
        MODEL_ROLES.filter((role) => role.kind === kind).map((role) => at(`Add a model for ${role.label.toLowerCase()}`));

    const helpers = roleAt(`helper`);
    const runs = roleAt(`run`);
    const automaticTier = at(`Add a model for automatic tier selection`);

    expect(helpers).not.toContain(-1);
    expect(runs).not.toContain(-1);
    expect(Math.max(...helpers)).toBeLessThan(Math.min(...runs));
    expect(Math.max(...runs)).toBeLessThan(automaticTier);
    // …and it is the LAST row on the page, not merely after the roles: anything drawn under it would be read as
    // reaching further still, which nothing here does.
    expect(automaticTier).toBe(adders.length - 1);
    // Within each block, the catalog's order. The rows are drawn by walking MODEL_ROLES, so this is what stops
    // one being re-sorted here and leaving the table's own stated ordering describing a page it no longer
    // matches.
    expect([...helpers, ...runs]).toEqual([...helpers, ...runs].toSorted((left, right) => left - right));
});

/* A ONE-SHOT ROW WITH NOTHING IN IT NAMES NO MODEL, and this is the test that would catch the derived ladder
 * coming back. It used to draw "Auto: Gemini 3 Flash Lite, then Claude Haiku 4.5, …" — a ranking this app
 * invented over accounts connected for something else, re-ranking itself whenever one was added. Both
 * connected fixtures are named here rather than just one, because a resolver that started deriving again
 * would put whichever it preferred on screen and half an assertion would still pass. */
test("names no model at all for a one-shot job nobody has set one for", async () => {
    const host = mount();
    await Promise.resolve();

    expect(chips(host)[`Commit messages`]).toBe(`off`);
    expect(host.textContent).not.toContain(`Claude Haiku 4.5`);
    expect(host.textContent).not.toContain(`GPT 5.6 Luna`);
    expect(orderOnScreen(host)).toEqual([]);
});

/* AN UNSET ROW STATES ITSELF IN A WORD, and the word differs by what an empty list MEANS for that job — a
 * one-shot does not happen at all, a whole session opens on the model the owner picked for their own chat.
 *
 * IT USED TO BE A PARAGRAPH, one per row ("Not set: this does not run…", "Composer default: whatever your chat
 * is set to…"), and on a sandbox nobody has configured that is every row on the page: eighteen paragraphs whose
 * content is that no choices have been made yet. The fact is worth a chip beside the name; the sentence behind
 * it is worth a tooltip. So what is pinned here is both halves — the chip says the right thing, and the prose
 * it replaced is gone rather than sitting under it as well. */
test("an unset job states itself in a chip beside its name, not in a paragraph under it", async () => {
    const host = mount();
    await Promise.resolve();

    const stated = chips(host);
    for (const role of MODEL_ROLES) {
        expect(stated[role.label], role.id).toBe(unsetChip(role.kind));
    }
    expect(host.textContent).not.toContain(`Not set`);
    expect(host.textContent).not.toContain(`Composer default`);
});

// …and a row that HAS models says nothing extra: the list under it names them in the order they will be tried,
// which is more than a chip could, so a chip there would be repeating the row back to itself.
test("a job with models drops the chip, because its list already says what it will do", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    expect(chips(host)[`Commit messages`]).toBe(``);
    expect(chips(host)[`Session titles`]).toBe(unsetChip(`helper`));
});

/* THE CHIP IS A CLAIM ABOUT WHAT THE JOB WILL DO, so it may not be drawn over a record nobody has read: "off"
 * while the settings are still in flight is a lie that corrects itself a moment later, which is worse than a
 * beat of silence — and it is the state every visit to this page passes through. */
test("says nothing about a job until the settings have landed", async () => {
    settings.value = undefined as unknown as SandboxSettings;
    const host = mount();
    await Promise.resolve();

    expect(chips(host)[`Commit messages`]).toBe(``);
    expect(chips(host)[`Pipeline fixes`]).toBe(``);
});

test("shows the pinned models in the order the setting holds them", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`, `CLAUDE · Claude Haiku 4.5`]);
});

test("moving one earlier writes the whole new order back", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = mount();
    await Promise.resolve();

    // The first row has nowhere above it to go, so its button is off rather than a no-op that looks live.
    expect(rowButton(host, `Move CODEX · GPT 5.6 Luna earlier`).disabled).toBe(true);
    rowButton(host, `Move CLAUDE · Claude Haiku 4.5 earlier`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [entry(`claude`, `claude-haiku-4-5`), entry(`codex`, `gpt-5.6`)] } });
});

test("removing the last one empties the list, which is how a job gets switched off", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [] } });
});

test("keeps a pin whose account went away on screen, and says why it is greyed", async () => {
    // The resolver drops it at run time so the helpers keep working. Dropping it from the ROW as well would
    // look like the app had eaten a setting the user made.
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`gemini`, `gemini-3-flash-lite`), entry(`claude`, `claude-haiku-4-5`)] } };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`GEMINI · Gemini 3 Flash Lite`, `CLAUDE · Claude Haiku 4.5`]);
    const disconnected = host.querySelector(`ol li`) as HTMLElement;
    expect(disconnected?.className).toMatch(/opacity|subtle|disabled/i);
});

/* THE SAFETY JUDGE'S MODEL IS ONE OF THESE ROWS, and that is the point of the row rather than a detail of it.
 * It used to be a fourth list editor on the Safety tab, which left this page — whose whole subject is which AI
 * does which job — quietly missing one, and left "where do I choose a model" with two answers. What these pin is
 * that it behaves like its neighbours and writes its OWN list: a judge row that wrote the commit-message list
 * would silently re-point every commit message in the sandbox. */

test("the judge row writes its own setting, never another job's", async () => {
    const host = mount();
    await Promise.resolve();

    addButton(host, `Add a model for safety judge`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] } });
    // And it left every other job's list exactly where it was: the record is written whole, so a row that read
    // the wrong key would show up here as another role's entry appearing or vanishing.
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[COMMIT]).toBeUndefined();
});

test("a pinned judge model is drawn as written, and removing it empties its own list", async () => {
    settings.value = { ...settings.value, modelRoles: { [JUDGE]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    // The only list with anything in it, so the page's rows read as one order.
    expect(orderOnScreen(host)).toEqual([`CODEX · GPT 5.6 Luna`]);

    rowButton(host, `Remove CODEX · GPT 5.6 Luna`).click();
    expect(patch).toHaveBeenCalledWith({ modelRoles: { [JUDGE]: [] } });
});

/* THE ONE ROW WHOSE FEATURE HAS AN OFF SWITCH SOMEWHERE ELSE. A control that goes dead with no explanation is
 * indistinguishable from a broken page, and the switch is a tab away, so the row has to both refuse the press
 * and say where the press that matters lives. */
test("goes inert with the judge, and says where the switch is", async () => {
    settings.value = { ...settings.value, commandJudge: `off` };
    const host = mount();
    await Promise.resolve();

    expect(addButton(host, `Add a model for safety judge`).disabled).toBe(true);
    const link = [...host.querySelectorAll<HTMLAnchorElement>(`a[href]`)].find((anchor) => anchor.textContent?.includes(`Turn the judge on`));
    expect(link?.getAttribute(`href`)).toBe(`/sandbox/agent?section=safety`);
});

test("the judge row stays live while the judge is merely watching", async () => {
    // Watch records verdicts without holding anything, so a model is still being spent on every flagged command
    // and the row that picks it must stay pressable.
    settings.value = { ...settings.value, commandJudge: `watch` };
    const host = mount();
    await Promise.resolve();

    expect(addButton(host, `Add a model for safety judge`).disabled).toBe(false);
});

/* EACH AGENT-RUN ENTRY CARRIES ITS OWN RUN SETTINGS, which is what this page was rebuilt for: the effort used
 * to be one control beside the list, answering for a frontier head and the cheap account under it alike. So
 * what these pin is that the row SAYS what its own entry will run at, and that moving that knob moves nothing
 * else. */

test("an agent-run entry names its own tier, and one left at the provider's default names nothing", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
                [RUN]: [
                    { provider: `claude`, model: `claude-haiku-4-5`, effort: `high` },
                    { provider: `codex`, model: `gpt-5.6` },
                ],
        },
    };
    const host = mount();
    await Promise.resolve();

    const rows = [...host.querySelectorAll(`ol li`)].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
    expect(rows[0]).toContain(`High`);
    // The second entry pinned no knobs, so it reads as just a model: the line exists to make a deliberate
    // choice legible, not to give every field a value.
    expect(rows[1]).toContain(`GPT 5.6 Luna`);
    expect(rows[1]).not.toMatch(/High|Low|thinking/);
});

test("a tier off the model's own scale is drawn as the one that will actually run", async () => {
    // Claude's API refuses `max` with thinking disabled, and THIS entry disabled it, so the row must not promise
    // a rung this run cannot use. The stored pick is left alone underneath.
    settings.value = { ...settings.value, modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: false }] } };
    const host = mount();
    await Promise.resolve();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`X-High`);
    expect(settings.value.modelRoles[RUN]?.[0]?.effort).toBe(`max`);
});

// …while an entry that pinned no thinking at all is not that pair: the turn goes out with no thinking field and
// the daemon names the reasoning the tier needs, so the row says the tier the entry actually spends.
test("an entry that pinned no thinking keeps the top tier it asked for", async () => {
    settings.value = { ...settings.value, modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `max` }] } };
    const host = mount();
    await Promise.resolve();

    expect(host.querySelector(`ol li`)?.textContent).toContain(`Max`);
});

test("pressing an agent-run row opens the picker over that entry, with its knobs", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
                [RUN]: [
                    { provider: `codex`, model: `gpt-5.6` },
                    { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
                ],
        },
    };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` });
    expect(opened?.knobs).toBe(true);
    // Both entries are already written down, so neither can be pinned a second time.
    expect(opened?.taken).toEqual([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]);
});

/* A ONE-SHOT ROW GETS THE KNOBS TOO, and it did not use to. The argument against was that the daemon runs those
 * jobs with thinking disabled and no effort, so a reasoning control would be a switch with nothing behind it —
 * true of the machinery, and it had become the reason for itself: an owner who pinned a reasoning model to their
 * commit subjects paid its price and got a cheaper model's behaviour. The one-shot path carries the knobs now,
 * so the picker offers them. */
test("a one-shot row opens the picker with knobs, because its job now honours them", async () => {
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(opened?.knobs).toBe(true);
});

/* THE CHEAPER-TIER LIST IS THE ONE ROW LEFT WITHOUT THEM, and that exception is real rather than left over:
 * automatic tier selection substitutes a model into a turn that already carries its own effort, and it never
 * touches an unattended run, so a control there would be the switch with nothing behind it. */
test("the cheaper-tier row opens the picker without knobs: its substitution cannot honour one", async () => {
    settings.value = { ...settings.value, autoFastModels: [`codex:gpt-5.6`] };
    const host = mount();
    await Promise.resolve();

    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    expect(opened?.pin).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(opened?.knobs).toBe(false);
});

test("a knob moved in the picker lands on that entry alone", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
                [RUN]: [
                    { provider: `codex`, model: `gpt-5.6`, effort: `high` },
                    { provider: `claude`, model: `claude-haiku-4-5` },
                ],
        },
    };
    const host = mount();
    await Promise.resolve();
    rowButton(host, `Change CLAUDE · Claude Haiku 4.5`).click();
    await flush();

    answer?.configure({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });

    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
                [RUN]: [
                    { provider: `codex`, model: `gpt-5.6`, effort: `high` },
                    { provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true },
                ],
        },
    });
    // The panel stays open over the entry it is configuring, and now reads the new state: these are settings of
    // the entry rather than the answer the panel was opened for.
    await flush();
    expect(opened?.pin).toEqual({ provider: `claude`, model: `claude-haiku-4-5`, effort: `max`, thinking: true });
});

test("re-pointing an entry replaces it where it stands, because its position is the other half of the setting", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: {
                [RUN]: [
                    { provider: `codex`, model: `gpt-5.6` },
                    { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
                ],
        },
    };
    const host = mount();
    await Promise.resolve();
    rowButton(host, `Change CODEX · GPT 5.6 Luna`).click();
    await flush();

    answer?.pick({ provider: `claude`, model: `claude-opus-5`, effort: `max` });

    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
                [RUN]: [
                    { provider: `claude`, model: `claude-opus-5`, effort: `max` },
                    { provider: `claude`, model: `claude-haiku-4-5`, effort: `low` },
                ],
        },
    });
});

/* ADDING APPENDS, AND A ROW WRITES THE WHOLE RECORD BACK. The second half is the property worth guarding: the
 * settings patch merges at the top level only, so a row that sent its own key alone would drop every other
 * job's list on the way past — the failure would be silent, and would look exactly like the page working. */
test("adding appends to the end of the order, and leaves every other job's list standing", async () => {
    const host = mount();
    await Promise.resolve();

    addButton(host, `Add a model for pipeline fixes`).click();
    await flush();
    expect(opened?.pin).toBeUndefined();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` });
    expect(patch).toHaveBeenCalledWith({ modelRoles: { [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` }] } });

    // A different job's row, over settings that now hold the first one: what goes back carries BOTH.
    addButton(host, `Add a model for commit messages`).click();
    await flush();
    answer?.pick({ provider: `codex`, model: `gpt-5.6` });
    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [RUN]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `high` }],
            [COMMIT]: [entry(`codex`, `gpt-5.6`)],
        },
    });
});

/* ═══ SETTING SEVERAL JOBS AT ONCE ═══
 *
 * THE COST OF ONE LIST PER JOB, PAID BACK. Seventeen true per-job settings are the right model and they made
 * the commonest sentence anybody wants to say — "all of these, on this, at this tier" — seventeen trips
 * through the same panel. What these tests pin is that the saving is real and that it is EXACT: one patch, the
 * ticked jobs and no others, the model AND the tier, and the untouched jobs still standing afterwards. A bulk
 * writer that quietly caught a neighbouring role would be invisible on screen and would re-point a job the
 * owner never selected. */

// A job's tick, by the row it belongs to. PrimeVue draws the box as a wrapper around a real checkbox input,
// and the aria-label rides that input, which is also the thing a click has to land on.
const tickBox = (host: HTMLElement, label: string): HTMLInputElement =>
    [...host.querySelectorAll<HTMLInputElement>(`input[type="checkbox"]`)].find((box) => box.getAttribute(`aria-label`) === label)!;

const tick = (host: HTMLElement, label: string): void => {
    const box = tickBox(host, label);
    box.checked = true;
    box.dispatchEvent(new Event(`change`, { bubbles: true }));
};

/* THE SELECTION'S VERBS LIVE IN THE GROUP'S OWN HEADER, above the rows and stuck there as they scroll. Read
 * off the words on the buttons rather than off a container id: what a caller has to be able to find is the
 * verb, and the header is a <RowGroup> slot rather than a landmark of its own. */
const barButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(label))!;

/* THE VERBS APPEAR WITH A SELECTION AND NOT BEFORE. They used to sit in a pill floating over the canvas, which
 * covered the last row for as long as a selection was live; in the header they would instead be two greyed
 * buttons on every visit to a page nobody is bulk-editing, which is the other way to get this wrong. */
// Every verb on the page, by its words: what has to change when a job is ticked is which of them exist.
const verbs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(`button`)]
        .map((button) => button.textContent?.replace(/\s+/g, ` `).trim() ?? ``)
        .filter((label) => label.includes(`Set a model for all`) || label.includes(`Clear models`));

test("no bulk verbs until something is ticked", async () => {
    const host = mount();
    await Promise.resolve();

    expect(verbs(host)).toEqual([]);

    tick(host, `Select commit messages`);
    await nextTick();

    expect(verbs(host)).toEqual([`Set a model for all…`, `Clear models`]);
});

test("one pick lands on every ticked job, in one patch, and leaves the rest alone", async () => {
    // One job starts with a list of its own, so the write is visibly an ADD to what is there rather than a
    // replacement: a bulk editor that flattened existing orders would silently drop the fallbacks somebody
    // wrote by hand.
    settings.value = { ...settings.value, modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } };
    const host = mount();
    await Promise.resolve();

    tick(host, `Select commit messages`);
    tick(host, `Select pipeline fixes`);
    await nextTick();
    barButton(host, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({
        modelRoles: {
            [COMMIT]: [entry(`codex`, `gpt-5.6`), entry(`claude`, `claude-haiku-4-5`)],
            [RUN]: [entry(`claude`, `claude-haiku-4-5`)],
        },
    });
    // The job that was not ticked is not in the record at all, so nothing was written for it.
    expect(patch.mock.calls.at(-1)?.[0]?.modelRoles?.[JUDGE]).toBeUndefined();
});

/* THE TIER IS THE OTHER HALF OF THE GESTURE, and it is why the bulk panel does not close on its pick the way
 * every row's does. The picker only draws its knobs over an entry that exists (ModelPinPickerBody), so the
 * model lands first and the panel stays up on it; the effort chosen next has to reach the SAME entry in every
 * ticked job rather than joining it as a second one. */
test("the tier chosen after the model reaches the same entry in every ticked job", async () => {
    const host = mount();
    await Promise.resolve();

    tick(host, `Select commit messages`);
    tick(host, `Select session titles`);
    await nextTick();
    barButton(host, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });
    await flush();

    // Still open, and now over the pin it just wrote, which is what puts the knobs on screen.
    expect(host.querySelector(`.pin-picker`)).not.toBeNull();
    expect(opened?.pin).toEqual(entry(`claude`, `claude-haiku-4-5`));

    answer?.configure({ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` });

    expect(patch).toHaveBeenLastCalledWith({
        modelRoles: {
            [COMMIT]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` }],
            [`session-title`]: [{ provider: `claude`, model: `claude-haiku-4-5`, effort: `low` }],
        },
    });
});

// A second model pick from the still-open panel is a RE-POINT of the entry it just wrote, not a second entry:
// the user is correcting themselves, and leaving the abandoned model behind in every ticked job is the one
// mistake this panel staying open makes possible.
test("picking again supersedes the model the same panel just wrote", async () => {
    const host = mount();
    await Promise.resolve();

    tick(host, `Select commit messages`);
    await nextTick();
    barButton(host, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });
    answer?.pick({ provider: `codex`, model: `gpt-5.6` });

    expect(patch).toHaveBeenLastCalledWith({ modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)] } });
});

test("clearing the ticked jobs empties their lists, which is how several jobs are switched off at once", async () => {
    settings.value = {
        ...settings.value,
        modelRoles: { [COMMIT]: [entry(`codex`, `gpt-5.6`)], [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] },
    };
    const host = mount();
    await Promise.resolve();

    tick(host, `Select commit messages`);
    await nextTick();
    barButton(host, `Clear models`).click();

    expect(patch).toHaveBeenCalledWith({ modelRoles: { [COMMIT]: [], [JUDGE]: [entry(`claude`, `claude-haiku-4-5`)] } });
});

test("the master box ticks every job on the page, and only the jobs", async () => {
    const host = mount();
    await Promise.resolve();

    tick(host, `Select every job`);
    await nextTick();
    barButton(host, `Set a model for all`).click();
    await flush();
    answer?.pick({ provider: `claude`, model: `claude-haiku-4-5` });

    const written = patch.mock.calls.at(-1)?.[0]?.modelRoles ?? {};
    expect(Object.keys(written).toSorted()).toEqual(MODEL_ROLES.map((role) => role.id).toSorted());
    // Automatic tier is a setting rather than a job, so the master box may not reach it: it is not a role, and
    // its list stores keys without knobs, which a pin written here would not be.
    expect(patch.mock.calls.at(-1)?.[0]?.autoFastModels).toBeUndefined();
});

/* THE AUTOMATIC-TIER ROW is the only setting on this page that can override a model the user picked a second
 * ago, so what these pin is the two things a reader has to be able to trust: that its DEFAULT changes nothing,
 * and that the screen says so. A control whose default has no visible effect reads as broken unless the row
 * states that having no effect IS the effect. */

// The three-way mode control, by the label a person clicks.
const modeButton = (host: HTMLElement, label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>(`[role="tablist"] button`)].find((button) => button.textContent?.trim() === label)!;

test("defaults to measuring", async () => {
    const host = mount();
    await Promise.resolve();

    expect(settings.value.autoTier).toBe(`shadow`);
    expect(modeButton(host, `Measure`).getAttribute(`aria-selected`)).toBe(`true`);
});

test("switching the mode writes it, and the row then describes what it actually does", async () => {
    const host = mount();
    await Promise.resolve();
    const before = host.textContent ?? ``;
    modeButton(host, `On`).click();

    expect(patch).toHaveBeenCalledWith({ autoTier: `on` });
    await Promise.resolve();
    expect(host.textContent).not.toBe(before);
});

test("off says the judgement stops too, not merely the routing", async () => {
    const host = mount();
    await Promise.resolve();
    const measuring = host.textContent ?? ``;
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toBe(measuring);
    expect(patch).toHaveBeenCalledWith({ autoTier: `off` });
});

test("names the rule behind Auto, because which model it picks depends on a conversation this page cannot see", async () => {
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).toContain(`Auto`);
    expect(orderOnScreen(host)).toEqual([]);
});

test("a pinned cheap model is drawn as written, in its own list", async () => {
    settings.value = { ...settings.value, autoFastModels: [`claude:claude-haiku-4-5`] };
    const host = mount();
    await Promise.resolve();

    expect(orderOnScreen(host)).toEqual([`CLAUDE · Claude Haiku 4.5`]);
});

test("the judge's record renders its three numbers once turns have been judged", async () => {
    const tier = { judged: 40, fast: 10, atStakeUsd: 1.5, routed: 4, routedUsd: 0.25, escalated: 1, denied: 2 };
    savings.value = { tier };
    const host = mount();
    await Promise.resolve();

    /* NO SPACE BEFORE `of`, AND THAT IS NOT A TYPO. The figure and the unit it is a figure OF are two spans of
     * one <Verdict> now — the space between them is the flex gap, so it is in the layout rather than in the
     * text. Asserted as one string anyway, because what this test is for is that the count still lands against
     * its own denominator: read apart, `10` and `of 40 turns` would both pass while reporting nothing. */
    expect(host.textContent).toContain(`${tier.fast}of ${tier.judged} turns judged simple`);
    expect(host.textContent).toContain(String(tier.routed));
    expect(host.textContent).not.toContain(`$1.50`);
    expect(host.textContent).toContain(`${tier.escalated}/${tier.fast}`);
    expect(host.textContent).toContain(String(tier.denied));
});

test("no judged turns means no numbers at all: absence, not a row of zeros", async () => {
    const host = mount();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`Last 30 days`);
});

/* THE ONE DIAL. It is the answer to the numbers above it, so what these pin is that it is reachable from the
 * same screen, that it writes what it says, and that it disappears with the feature rather than sitting there
 * adjusting a judge that never runs. */

test("the dial defaults to balanced and writes the stop that was clicked", async () => {
    const host = mount();
    await Promise.resolve();

    expect(modeButton(host, `Balanced`).getAttribute(`aria-selected`)).toBe(`true`);
    modeButton(host, `Eager`).click();

    expect(patch).toHaveBeenCalledWith({ autoTierEagerness: `eager` });
});

test("the eagerness dial goes away with the feature, not just the mode control", async () => {
    const host = mount();
    await Promise.resolve();
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`Cautious`);
});

test("the dial goes away with the feature, rather than adjusting a judge that never runs", async () => {
    const host = mount();
    await Promise.resolve();
    modeButton(host, `Off`).click();
    await Promise.resolve();

    expect(host.textContent).not.toContain(`How readily`);
});
