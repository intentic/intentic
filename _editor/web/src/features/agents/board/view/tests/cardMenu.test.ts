import "@intentic/testing/dom";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { reviewAction } from "../../../../../models/agent-status/agentStatus-attention";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import { useVocabulary } from "../../../../../workbench/views/vocabulary";
import { type MenuActions, type MenuFacts, menuItemsFor, useCardMenu } from "../cardMenu";

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
    canShip: true,
    href: () => `/agents/a1`,
    boxName: undefined,
    ...over,
});
const actions = (): { [K in keyof MenuActions]: ReturnType<typeof jest.fn> & MenuActions[K] } => ({
    focusAgent: jest.fn(),
    reviewAgent: jest.fn(),
    drillIn: jest.fn(),
    closeAgent: jest.fn(),
    copySessionName: jest.fn(async () => undefined),
    openInSandbox: jest.fn(),
    stopWatching: jest.fn(async () => undefined),
    restore: jest.fn(async () => undefined),
    archive: jest.fn(async () => undefined),
    startFresh: jest.fn(),
    land: jest.fn(),
    exportTranscript: jest.fn(),
    setAutoApprove: jest.fn(),
    stopAll: jest.fn(),
});
// The rows as a reader sees them: a label, or a rule between groups.
const rows = (items: readonly MenuItem[]): string[] => items.map((item) => (item.separator === true ? `—` : String(item.label)));
const press = (items: readonly MenuItem[], label: string): void => {
    const item = items.find((candidate) => candidate.label === label);
    item?.command?.({ originalEvent: new Event(`click`), item });
};

const landed = card(`a1`, { branch: `agent/sleek-arrow-uzgj` });
const wrote = { ...landed, diff: { files: 1, insertions: 3, deletions: 0 } };
const OPEN_CHAT = t(`agents.agentStatus.openChat`);
const VIEW_CHANGES = t(`agents.agentStatus.viewChanges`);
const WATCH = { id: `w`, note: `CI on main passes`, intervalSeconds: 60, deadlineAt: 9_999 };

describe(`what a card's menu offers`, () => {
    // One icon per destination: the chat's, the diff's. The page is always View changes, and only with something on it:
    // a card that wrote nothing offers no "Details" to a page saying so (2026-11-04).
    it(`opens its chat, views its changes at their own address, copies the session name and files a finished card away`, () => {
        const items = menuItemsFor(wrote, facts(), actions());
        expect(rows(items)).toEqual([
            OPEN_CHAT,
            VIEW_CHANGES,
            `—`,
            t(`agents.freshSession.menuFresh`),
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        expect(items[0]).toMatchObject({ icon: `comments` });
        expect(items[1]).toMatchObject({ icon: `diff`, url: `/agents/a1` });
        expect(rows(menuItemsFor(landed, facts(), actions()))).toEqual([
            OPEN_CHAT,
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
    });

    // The whole conversation as one file, beside its session name, only where the daemon serves it to this reader, and never
    // for a card the sandbox holds no record of.
    it(`exports a registered card's transcript beside its session name, where the reader may take it`, () => {
        const act = actions();
        const items = menuItemsFor(landed, facts({ exportable: true }), act);
        expect(rows(items)).toEqual([
            OPEN_CHAT,
            `—`,
            t(`agents.agentsView.copySessionName`),
            t(`agents.cardMenu.exportTranscript`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        press(items, t(`agents.cardMenu.exportTranscript`));
        expect(act.exportTranscript.mock.calls).toEqual([[landed]]);
        expect(rows(menuItemsFor(landed, facts(), actions()))).not.toContain(t(`agents.cardMenu.exportTranscript`));
        expect(rows(menuItemsFor(card(`new`, { status: `draft` }), facts({ exportable: true }), actions()))).toEqual([OPEN_CHAT, `—`, t(`ui.action.close`)]);
    });

    // An error is read in the chat, not on a diff page that cannot show it.
    it(`names an error's way in and leads it to the chat`, () => {
        const crashed = card(`e`, { status: `error`, branch: `agent/e` });
        const act = actions();
        const items = menuItemsFor(crashed, facts(), act);
        expect(rows(items).slice(0, 2)).toEqual([OPEN_CHAT, reviewAction(crashed)!]);
        expect(items[1]).toMatchObject({ icon: `comments` });
        expect(rows(items)).not.toContain(VIEW_CHANGES);
        press(items, reviewAction(crashed)!);
        expect(act.drillIn.mock.calls).toEqual([[crashed]]);
    });

    // A spent allowance's drill-in is its chat; the partial work it wrote stays one row away, at the review's address.
    it(`offers a stranded card's partial work as View changes beside its chat`, () => {
        const stranded = card(`limit`, { status: `error`, failureCode: `rate_limit`, branch: `agent/limit`, diff: { files: 1, insertions: 20, deletions: 2 } });
        const act = actions();
        const items = menuItemsFor(stranded, facts(), act);
        expect(rows(items).slice(0, 3)).toEqual([OPEN_CHAT, VIEW_CHANGES, `—`]);
        expect(items[1]).toMatchObject({ icon: `diff`, url: `/agents/a1` });
        press(items, t(`agents.agentStatus.viewChanges`));
        expect([act.reviewAgent.mock.calls, act.drillIn.mock.calls]).toEqual([[[stranded]], []]);
        // Nothing written, nothing to review: the chat alone.
        const empty = menuItemsFor({ ...stranded, diff: undefined }, facts(), actions());
        expect(rows(empty)).not.toContain(t(`agents.agentStatus.viewChanges`));
    });

    // Its label is the ask's verb, so it goes where the ask is answered, the chat, and names no page that draws nothing.
    it(`answers an ask in the chat, with no link to a review page`, () => {
        const asking = card(`ask`, { status: `awaiting`, attention: { ...NO_ATTENTION, permission: true }, branch: `agent/ask` });
        const act = actions();
        const items = menuItemsFor(asking, facts(), act);
        expect(items[1]).toEqual({ label: `Approve`, icon: `comments`, command: expect.any(Function) });
        press(items, `Approve`);
        expect([act.drillIn.mock.calls, act.reviewAgent.mock.calls]).toEqual([[[asking]], []]);
    });

    it(`leaves the review to the card's own tap on a phone`, () => {
        expect(rows(menuItemsFor(landed, facts({ mobile: true }), actions()))).toEqual([
            OPEN_CHAT,
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
    });

    // The card's own Land now, beside the review it would otherwise send the reader to: a maintainer's press, and Land
    // again in its place where landed work left the workspace, since a plain land would leave that part missing.
    it(`lands a ready card from its menu, and lands again where landed work went missing`, () => {
        const words = useVocabulary().value;
        const ready = card(`r`, { status: `ready`, branch: `agent/r`, diff: { files: 1, insertions: 1, deletions: 0 } });
        const act = actions();
        const items = menuItemsFor(ready, facts(), act);
        expect(rows(items).slice(0, 3)).toEqual([OPEN_CHAT, VIEW_CHANGES, words.land]);
        press(items, words.land);
        const away = card(`a`, { branch: `agent/a`, landedPresence: { landed: 2, present: 0 } });
        press(menuItemsFor(away, facts(), act), words.landAgain);
        expect(act.land.mock.calls).toEqual([
            [ready, `land`],
            [away, `reland`],
        ]);
        // An agent took it out on purpose, a collaborator may not land, and work filed away waits for its restore.
        const takenByAgent = { ...away, landedPresence: { landed: 2, present: 0, removedBy: { kind: `agent` as const, id: `o` } } };
        expect(rows(menuItemsFor(takenByAgent, facts(), act))).not.toContain(words.landAgain);
        expect(rows(menuItemsFor(ready, facts({ canShip: false }), act))).not.toContain(words.land);
        expect(rows(menuItemsFor({ ...ready, archivedAt: 9 }, facts(), act))).not.toContain(words.land);
    });

    it(`restores an archived card, and closes a draft that has nothing to file`, () => {
        expect(rows(menuItemsFor(card(`old`, { archivedAt: 9 }), facts(), actions()))).toEqual([OPEN_CHAT, `—`, t(`ui.action.restore`)]);
        expect(rows(menuItemsFor(card(`new`, { status: `draft` }), facts(), actions()))).toEqual([OPEN_CHAT, `—`, t(`ui.action.close`)]);
    });

    it(`ends every armed watch in one row, counting them past one`, () => {
        const one = card(`w1`, { status: `running`, watches: [WATCH], awaitingWake: true });
        const three = card(`w3`, { status: `running`, watches: [WATCH, WATCH, WATCH], awaitingWake: true });
        expect(rows(menuItemsFor(one, facts(), actions()))).toEqual([OPEN_CHAT, `—`, `Stop watching`]);
        expect(rows(menuItemsFor(three, facts(), actions()))).toEqual([OPEN_CHAT, `—`, `Stop watching (3)`]);
    });

    // A workflow run starts the next agent as each one stops, with its card at rest: Stop everything is the press that ends
    // it with every agent below, offered only while something there is going (familyStop.ts).
    it(`stops everything below a card while a workflow run or a subagent is going, beside the watch`, () => {
        const run = { id: `wfr-1`, name: `spaces-materialize`, calls: 13, working: 3, failed: 2, startedAt: 1 };
        const scripted = card(`s1`, { status: `stopped`, scriptRuns: [run] });
        const helped = card(`s2`, { status: `running`, subagents: { running: 2, total: 5 }, watches: [WATCH], awaitingWake: true });
        const act = actions();
        const items = menuItemsFor(scripted, facts(), act);
        expect(rows(items)).toEqual([OPEN_CHAT, `—`, t(`agents.cardMenu.stopAll`), `—`, t(`agents.agentsView.archive`)]);
        expect(rows(menuItemsFor(helped, facts(), actions()))).toEqual([OPEN_CHAT, `—`, t(`agents.cardMenu.stopAll`), `Stop watching`]);
        items.find((item) => item.label === t(`agents.cardMenu.stopAll`))?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(act.stopAll).toHaveBeenCalledWith(scripted);
        expect(rows(menuItemsFor(card(`s3`, { status: `running`, subagents: { running: 0, total: 5 } }), facts(), actions()))).toEqual([OPEN_CHAT]);
        expect(rows(menuItemsFor(card(`s4`, { status: `idle`, scriptRuns: [run], archivedAt: 3 }), facts(), actions()))).not.toContain(t(`agents.cardMenu.stopAll`));
    });

    it(`offers another box's card the crossing to it by name, and nothing that writes through this box`, () => {
        const far = card(`far`, { sandboxId: `laptop`, archivedAt: 3, watches: [WATCH], awaitingWake: true });
        expect(rows(menuItemsFor(far, facts({ here: false, boxName: `Laptop` }), actions()))).toEqual([t(`ui.action.open`), `—`, `Open in Laptop`]);
        expect(rows(menuItemsFor(far, facts({ here: false }), actions()))).toEqual([t(`ui.action.open`), `—`, `Open in its sandbox`]);
    });

    // Renaming and reacting are the card's own (its title's field, its reactions' picker), so the card hands them over;
    // they sit beside the name they act on, and a card or child row that hands none gets neither row.
    it(`offers the presses the card hands over, beside its name`, () => {
        const rename = jest.fn();
        const react = jest.fn();
        const items = menuItemsFor(landed, facts({ presses: { rename, react } }), actions());
        expect(rows(items)).toEqual([
            OPEN_CHAT,
            `—`,
            t(`ui.action.rename`),
            t(`agents.agentReactions.addReaction`),
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        press(items, t(`ui.action.rename`));
        press(items, t(`agents.agentReactions.addReaction`));
        expect([rename.mock.calls, react.mock.calls]).toEqual([[[]], [[]]]);
        expect(rows(menuItemsFor(landed, facts({ presses: { react } }), actions()))).not.toContain(t(`ui.action.rename`));
        expect(rows(menuItemsFor(landed, facts({ presses: {} }), actions()))).toEqual(rows(menuItemsFor(landed, facts(), actions())));
    });

    // A second look by a session that never read how the work was made, only where there is work here to cut it from: one
    // row opening onto every kind, none of them first or required.
    it(`offers a fresh session on a card's work, one entry per kind, and starts it for that card`, () => {
        const worked = card(`w`, { branch: `agent/w`, diff: { files: 2, insertions: 5, deletions: 1 } });
        const act = actions();
        const items = menuItemsFor(worked, facts(), act);
        const fresh = items.find((item) => item.label === t(`agents.freshSession.menuFresh`));
        expect(rows(fresh?.items ?? [])).toEqual([t(`agents.freshSession.kind.review`), t(`agents.freshSession.kind.test`), t(`agents.freshSession.kind.ask`)]);
        for (const label of rows(fresh?.items ?? [])) {
            press(fresh?.items ?? [], label);
        }
        expect(act.startFresh.mock.calls).toEqual([
            [worked, `review`],
            [worked, `test`],
            [worked, `ask`],
        ]);
        expect(rows(menuItemsFor(landed, facts(), act))).not.toContain(t(`agents.freshSession.menuFresh`));
        expect(rows(menuItemsFor(worked, facts({ here: false }), act))).not.toContain(t(`agents.freshSession.menuFresh`));
    });

    it(`runs each row's own press on the card it was opened for`, () => {
        const act = actions();
        const items = menuItemsFor(wrote, facts(), act);
        for (const label of [
            OPEN_CHAT,
            VIEW_CHANGES,
            t(`agents.agentsView.copySessionName`),
            t(`agents.agentsView.archive`),
        ]) {
            press(items, label);
        }
        press(menuItemsFor(card(`far`, { sandboxId: `laptop` }), facts({ here: false }), act), `Open in its sandbox`);
        expect([
            act.focusAgent.mock.calls,
            act.reviewAgent.mock.calls,
            act.copySessionName.mock.calls,
            act.archive.mock.calls,
            act.openInSandbox.mock.calls,
        ]).toEqual([[[wrote]], [[wrote]], [[`agent/sleek-arrow-uzgj`]], [[[`a1`]]], [[`laptop`, `far`]]]);
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
            focusAgent: jest.fn(),
            reviewAgent: jest.fn(),
            drillIn: jest.fn(),
            closeAgent: jest.fn(),
            agentHref: (agent: FleetAgent) => `/agents/${agent.id}`,
        };
        const agents = {
            stopWatching: jest.fn(async () => undefined),
            restore: jest.fn(async () => undefined),
            archive: jest.fn(async () => undefined),
        };
        const effects = effectScope();
        running.push(effects);
        const menu = effects.run(() => useCardMenu({ mobile: ref(false), focus, agents, selected: (agent) => [agent] }))!;
        const show = jest.fn((_event: Event) => undefined);
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
            OPEN_CHAT,
            `—`,
            t(`agents.agentsView.copySessionName`),
            `—`,
            t(`agents.agentsView.archive`),
        ]);
        press(menu.cardMenuItems.value, OPEN_CHAT);
        expect(focus.focusAgent.mock.calls).toEqual([[landed]]);
    });

    // A press from the keyboard (Enter on the card's ⋯) says 0,0, which PrimeVue would open the menu at: the screen's corner.
    it(`hangs a keyboard-opened menu from the element pressed, and opens the card's picker from there`, () => {
        const pressed = document.createElement(`button`);
        document.body.appendChild(pressed);
        pressed.getBoundingClientRect = () => new DOMRect(400, 120, 20, 20);
        const { menu, show } = menuOf();
        const react = jest.fn();
        const keyed = new MouseEvent(`click`);
        Object.defineProperty(keyed, `currentTarget`, { value: pressed });
        menu.openCardMenu(landed, keyed, { react });
        const shown = show.mock.calls[0]?.[0];
        expect(shown instanceof MouseEvent ? [shown.clientX, shown.clientY] : shown).toEqual([400, 140]);
        press(menu.cardMenuItems.value, t(`agents.agentReactions.addReaction`));
        expect(react.mock.calls).toEqual([[pressed]]);

        // A pointer's own place is kept.
        const clicked = new MouseEvent(`contextmenu`, { clientX: 30, clientY: 60 });
        Object.defineProperty(clicked, `currentTarget`, { value: pressed });
        menu.openCardMenu(landed, clicked);
        expect(show.mock.calls[1]).toEqual([clicked]);
        expect(rows(menu.cardMenuItems.value)).not.toContain(t(`agents.agentReactions.addReaction`));
    });

    // jsdom has no clipboard; this one records what was written, then refuses as an insecure context would.
    it(`copies the bare session name through the pressed card's document, and says nothing when refused`, async () => {
        const written: string[] = [];
        const writeText = jest.fn(async (text: string) => {
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

// The auto-approve mark (sandbox-contract schemas/auto-approve.ts): one row, offered only where the reader may put it on,
// going the way the card pressed says, and taking along every card selected with it (the panes a Ctrl or Shift click
// opened) so several sessions are marked in one press.
describe(`a card's auto-approve row`, () => {
    const MARK = t(`agents.autoApprove.mark`);
    const marking = (selected: readonly FleetAgent[]): MenuFacts => facts({ autoApprove: { selected } });
    const rowOf = (items: readonly MenuItem[], label: string): MenuItem | undefined => items.find((item) => item.label === label);

    it(`sits between the watch and the filing, marks this card alone, and is not offered without the reader's reach`, () => {
        const act = actions();
        const items = menuItemsFor(landed, marking([landed]), act);
        expect(rows(items)).toEqual([OPEN_CHAT, `—`, t(`agents.agentsView.copySessionName`), `—`, MARK, `—`, t(`agents.agentsView.archive`)]);
        expect(rowOf(items, MARK)).toMatchObject({ icon: `bolt`, hint: t(`agents.autoApprove.markHint`) });
        press(items, MARK);
        expect(act.setAutoApprove.mock.calls).toEqual([[[`a1`], true]]);
        expect(rows(menuItemsFor(landed, facts(), actions()))).not.toContain(MARK);
        // Filed away, or another box's: nothing here can mark it.
        expect(rows(menuItemsFor({ ...landed, archivedAt: 5 }, marking([landed]), actions()))).not.toContain(MARK);
        expect(rows(menuItemsFor(landed, { ...marking([landed]), here: false }, actions()))).not.toContain(MARK);
    });

    it(`takes the card's own mark off, and says a card following its parent's is already approved`, () => {
        const act = actions();
        const own = menuItemsFor({ ...landed, autoApprove: `own` }, marking([]), act);
        expect(rowOf(own, t(`agents.autoApprove.unmark`))).toMatchObject({ icon: `shield`, hint: t(`agents.autoApprove.unmarkHint`) });
        press(own, t(`agents.autoApprove.unmark`));
        expect(act.setAutoApprove.mock.calls).toEqual([[[`a1`], false]]);
        const inherited = menuItemsFor({ ...landed, autoApprove: `inherited` }, marking([]), actions());
        expect(rowOf(inherited, MARK)).toMatchObject({ hint: t(`agents.autoApprove.inheritedHint`) });
    });

    it(`marks every card selected with the one pressed, and only that one when it is outside the selection`, () => {
        const act = actions();
        const others = [card(`a2`), card(`a3`, { autoApprove: `own` })];
        const items = menuItemsFor(landed, marking([landed, ...others]), act);
        const label = t(`agents.autoApprove.markSelected`, { count: 3 });
        expect(rows(items)).toContain(label);
        press(items, label);
        expect(act.setAutoApprove.mock.calls).toEqual([[[`a1`, `a2`, `a3`], true]]);
        // A marked card pressed takes the mark off them all.
        const off = menuItemsFor({ ...landed, autoApprove: `own` }, marking([landed, ...others]), act);
        press(off, t(`agents.autoApprove.unmarkSelected`, { count: 3 }));
        expect(act.setAutoApprove.mock.calls[1]).toEqual([[`a1`, `a2`, `a3`], false]);
        // A card not among the selected is marked alone.
        expect(rows(menuItemsFor(landed, marking(others), actions()))).toContain(MARK);
    });
});
