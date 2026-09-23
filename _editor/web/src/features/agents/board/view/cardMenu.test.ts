import "@intentic/testing/dom";
import { t } from "@intentic/ui/i18n";
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { MenuItem } from "primevue/menuitem";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { NO_ATTENTION, reviewAction } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { type MenuActions, type MenuFacts, menuItemsFor, useCardMenu } from "./cardMenu";

// Pins what the one card menu offers for each card: opening and its page, the look's keep, the session name, the crossing
// to another box, ending a watch and filing away or closing, each only where it can act, grouped with no stray
// separator; and that it opens on the card pressed and copies through that card's own window.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const facts = (over: Partial<MenuFacts> = {}): MenuFacts => ({
    mobile: false,
    here: true,
    peeked: false,
    href: () => `/agents/a1`,
    boxName: undefined,
    ...over,
});
const actions = (): { [K in keyof MenuActions]: ReturnType<typeof mock> & MenuActions[K] } => ({
    focusAgent: mock(),
    keepAgent: mock(),
    reviewAgent: mock(),
    closeAgent: mock(),
    copySessionName: mock(async () => undefined),
    openInSandbox: mock(),
    stopWatching: mock(async () => undefined),
    restore: mock(async () => undefined),
    archive: mock(async () => undefined),
});
// The rows as a reader sees them: a label, or a rule between groups.
const rows = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));
const press = (items: readonly MenuItem[], label: string): void => {
    const item = items.find((candidate) => candidate.label === label);
    item?.command?.({ originalEvent: new Event(`click`), item });
};

const landed = card(`a1`, { branch: `agent/sleek-arrow-uzgj` });
const WATCH = { id: `w`, note: `CI on main goes green`, intervalSeconds: 60, deadlineAt: 9_999 };

describe(`what a card's menu offers`, () => {
    it(`opens, reviews at its own address, copies the session name and files a finished card away`, () => {
        const items = menuItemsFor(landed, facts(), actions());
        expect(rows(items)).toEqual([
            t(`ui.action.open`),
            reviewAction(landed)!,
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        expect(items[1]).toMatchObject({ icon: `copy`, url: `/agents/a1` });
    });

    it(`keeps a look, and leaves the review to the card's own tap on a phone`, () => {
        expect(rows(menuItemsFor(landed, facts({ peeked: true, mobile: true }), actions()))).toEqual([
            t(`ui.action.open`),
            t(`agents.agentsView.keepOpen`),
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
    });

    it(`restores an archived card, and closes a draft that has nothing to file`, () => {
        expect(rows(menuItemsFor(card(`old`, { archivedAt: 9 }), facts(), actions()))).toEqual([
            t(`ui.action.open`),
            `—`,
            t(`agents.agentsView.restore`),
        ]);
        expect(rows(menuItemsFor(card(`new`, { status: `draft` }), facts(), actions()))).toEqual([t(`ui.action.open`), `—`, t(`ui.action.close`)]);
    });

    it(`ends every armed watch in one row, counting them past one`, () => {
        const one = card(`w1`, { status: `running`, watches: [WATCH] });
        const three = card(`w3`, { status: `running`, watches: [WATCH, WATCH, WATCH] });
        expect(rows(menuItemsFor(one, facts(), actions()))).toEqual([t(`ui.action.open`), `—`, `Stop watching`]);
        expect(rows(menuItemsFor(three, facts(), actions()))).toEqual([t(`ui.action.open`), `—`, `Stop watching (3)`]);
    });

    it(`offers another box's card the crossing to it by name, and nothing that writes through this box`, () => {
        const far = card(`far`, { sandboxId: `laptop`, archivedAt: 3, watches: [WATCH] });
        expect(rows(menuItemsFor(far, facts({ here: false, boxName: `Laptop` }), actions()))).toEqual([t(`ui.action.open`), `—`, `Open in Laptop`]);
        expect(rows(menuItemsFor(far, facts({ here: false }), actions()))).toEqual([t(`ui.action.open`), `—`, `Open in its sandbox`]);
    });

    it(`runs each row's own press on the card it was opened for`, () => {
        const act = actions();
        const items = menuItemsFor(landed, facts({ peeked: true }), act);
        for (const label of [
            t(`ui.action.open`),
            t(`agents.agentsView.keepOpen`),
            reviewAction(landed)!,
            t(`agents.agentsView.copySessionName`),
            t(`agents.agentsView.archive`),
        ]) {
            press(items, label);
        }
        press(menuItemsFor(card(`far`, { sandboxId: `laptop` }), facts({ here: false }), act), `Open in its sandbox`);
        expect([
            act.focusAgent.mock.calls,
            act.keepAgent.mock.calls,
            act.reviewAgent.mock.calls,
            act.copySessionName.mock.calls,
            act.archive.mock.calls,
            act.openInSandbox.mock.calls,
        ]).toEqual([[[landed]], [[landed]], [[landed]], [[`agent/sleek-arrow-uzgj`]], [[[`a1`]]], [[`laptop`, `far`]]]);
    });
});

describe(`the one menu`, () => {
    const running: EffectScope[] = [];
    afterEach(() => {
        for (const effects of running.splice(0)) {
            effects.stop();
        }
        document.body.replaceChildren();
    });
    const menuOf = () => {
        const focus = {
            focusAgent: mock(),
            keepAgent: mock(),
            reviewAgent: mock(),
            closeAgent: mock(),
            agentHref: (agent: FleetAgent) => `/agents/${agent.id}`,
        };
        const agents = { stopWatching: mock(async () => undefined), restore: mock(async () => undefined), archive: mock(async () => undefined) };
        const effects = effectScope();
        running.push(effects);
        const menu = effects.run(() => useCardMenu({ mobile: ref(false), peeked: (id) => id === `a1`, focus, agents }))!;
        const show = mock((_event: Event) => undefined);
        menu.cardMenu.value = { show };
        return { menu, show, focus };
    };

    it(`opens on the card pressed, with that card's rows`, () => {
        const { menu, show, focus } = menuOf();
        expect(menu.cardMenuItems.value).toEqual([]);
        const event = new MouseEvent(`contextmenu`);
        menu.openCardMenu(landed, event);
        expect(show.mock.calls).toEqual([[event]]);
        expect(rows(menu.cardMenuItems.value)).toEqual([
            t(`ui.action.open`),
            t(`agents.agentsView.keepOpen`),
            reviewAction(landed)!,
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        press(menu.cardMenuItems.value, t(`ui.action.open`));
        expect(focus.focusAgent.mock.calls).toEqual([[landed]]);
    });

    // jsdom has no clipboard; this one records what was written, then refuses as an insecure context would.
    it(`copies the bare session name through the pressed card's document, and says nothing when refused`, async () => {
        const written: string[] = [];
        const writeText = mock(async (text: string) => {
            written.push(text);
        });
        Object.defineProperty(navigator, `clipboard`, { configurable: true, value: { writeText } });
        const pressed = document.createElement(`div`);
        document.body.appendChild(pressed);
        const { menu } = menuOf();
        const event = new MouseEvent(`contextmenu`);
        Object.defineProperty(event, `currentTarget`, { value: pressed });
        menu.openCardMenu(landed, event);

        press(menu.cardMenuItems.value, t(`agents.agentsView.copySessionName`));
        await nextTick();
        expect(written).toEqual([`sleek-arrow-uzgj`]);

        writeText.mockImplementation(async () => {
            throw new Error(`insecure context`);
        });
        press(menu.cardMenuItems.value, t(`agents.agentsView.copySessionName`));
        await nextTick();
        expect(writeText).toHaveBeenCalledTimes(2);
        Reflect.deleteProperty(navigator, `clipboard`);
    });
});
