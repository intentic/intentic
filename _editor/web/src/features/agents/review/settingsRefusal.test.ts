// jsdom: the composable reads a query, which needs a mounted scope to live and die with.
import "@intentic/testing/dom";
import type { LandConflict } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// G4's leftover on the board: a refusal held only by files a Sandbox page wrote still read "Your edits" on the card while
// its review named the page. The card reads the review's own report, and only while it is refusing on the owner's half.

const { queryClient } = await import("../../../lib/queryPersistence");
const { rpcKey } = await import("../../../lib/queryKeys");
const { settingsChip, useSettingsRefusal } = await import("./settingsRefusal");
const { settingsPagesOf } = await import("./conflictResolution");

const held = (...paths: string[]): LandConflict[] => [{ repo: `root`, clean: 4, paths: paths.map((path) => ({ path, reason: `workspace` as const })) }];
const reported = (id: string, conflicts: readonly LandConflict[]): void => {
    queryClient.setQueryData(rpcKey(`agents.diff`, { id }), { repos: [], conflicts });
};
const diffRead = (id: string) => queryClient.getQueryCache().find({ queryKey: rpcKey(`agents.diff`, { id }) });

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    queryClient.clear();
});

const mounted = (id: string, refusing: { value: boolean }) => {
    let read: () => string | undefined = () => undefined;
    app = createApp(
        defineComponent({
            setup() {
                const pages = useSettingsRefusal(() => ({ id }), () => refusing.value);
                read = () => pages.value;
                return () => h(`div`);
            },
        }),
    );
    app.mount(document.createElement(`div`));
    return { pages: () => read() };
};

test(`a refusal held only by files the Sandbox pages wrote names those pages, as the review heading does`, () => {
    reported(`a1`, held(`.intentic/config/personas.json`, `.intentic/config/settings.json`));

    const card = mounted(`a1`, ref(true));

    expect(card.pages()).toBe(`Personas, Agent`);
});

test(`one file of the owner's own among them names no page`, () => {
    reported(`a1`, held(`.intentic/config/personas.json`, `src/config.ts`));

    expect(mounted(`a1`, ref(true)).pages()).toBeUndefined();
    expect(settingsPagesOf(held(`src/config.ts`))).toBeUndefined();
});

// A board holds many cards: one that isn't refusing reads nothing, and one that stops refusing lets its read go.
test(`only a card refusing on the owner's half reads the report, and it stops once the refusal clears`, async () => {
    const refusing = ref(false);
    const card = mounted(`b2`, refusing);
    expect(diffRead(`b2`)).toBeUndefined();

    refusing.value = true;
    await nextTick();
    reported(`b2`, held(`.intentic/config/capabilities.json`));
    expect(card.pages()).toBe(`Capabilities`);
    expect(diffRead(`b2`)?.getObserversCount()).toBe(1);

    refusing.value = false;
    await nextTick();
    expect(card.pages()).toBeUndefined();
    expect(diffRead(`b2`)?.getObserversCount()).toBe(0);
});

// The board card and the rail's row name such a refusal through one check, never by comparing the chip's words.
describe("the chip over a refusal Sandbox pages wrote", () => {
    const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
    const yours = { status: `conflict` as const, attention: { ...none, conflict: true }, conflictCauses: [`workspace` as const] };
    const chip = { label: `Your edits`, tone: `x` };

    test("reads Unsaved settings once the pages are known, keeping the chip's tone", () => {
        expect(settingsChip(chip, yours, `Models`)).toEqual({ label: `Unsaved settings`, tone: `x` });
        expect(settingsChip(chip, yours, undefined)).toBe(chip);
    });

    // A refusal the agent can redo is not the reader's edits, and a card asking something else leads with that ask.
    test("leaves every other chip as it is", () => {
        expect(settingsChip(chip, { ...yours, conflictCauses: [`diverged`] }, `Models`)).toBe(chip);
        expect(settingsChip(chip, { ...yours, attention: { ...yours.attention, permission: true } }, `Models`)).toBe(chip);
        expect(settingsChip(undefined, yours, `Models`)).toBeUndefined();
    });
});
