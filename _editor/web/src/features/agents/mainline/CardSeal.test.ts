import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import CardSeal from "./CardSeal.vue";
import type { CardChecks } from "./landCheck";

// THE SEAL MOVES ONLY WHILE SOMETHING IS HAPPENING TO THE WORK: main's check running on its land. A land still queued
// for that check has nothing happening to it yet, and a card whose own turn is working already has a spinner, so
// neither gets a stroke travelling its ring.

const NOW = 1_700_000_000_000;

let app: App | undefined;

const mount = async (props: { checks: CardChecks; still?: boolean; compact?: boolean }): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(CardSeal, props) });
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return el.querySelector<HTMLElement>(`[data-seal]`)!;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

const moving = (seal: HTMLElement): number => seal.querySelectorAll(`animate`).length;

it(`travels its ring while main's check runs on the land`, async () => {
    const seal = await mount({ checks: { land: { kind: `checking`, project: `web`, since: NOW } } });
    expect([seal.dataset[`sealKind`], moving(seal)]).toEqual([`checking`, 1]);
    expect(seal.className).toContain(`text-link`);
});

it(`holds still while the land only waits for that check`, async () => {
    const seal = await mount({ checks: { land: { kind: `waiting`, project: `web`, since: NOW } } });
    expect([seal.dataset[`sealKind`], moving(seal)]).toEqual([`queued`, 0]);
});

it(`holds still beside a card's own spinner, and still says the check is running`, async () => {
    const seal = await mount({ checks: { land: { kind: `checking`, project: `web`, since: NOW } }, still: true });
    expect(moving(seal)).toBe(0);
    expect(seal.querySelector(`svg`)?.getAttribute(`aria-label`)).toMatch(/^Main's check of web: running since /);
});

it(`says a red land's words beside the glyph only on the rail's row`, async () => {
    const broke: CardChecks = { land: { kind: `broke`, project: `web`, since: NOW, failures: 2 } };
    expect((await mount({ checks: broke, compact: true })).textContent?.trim()).toBe(`Broke 2`);
    app?.unmount();
    expect((await mount({ checks: broke })).textContent?.trim()).toBe(``);
});
