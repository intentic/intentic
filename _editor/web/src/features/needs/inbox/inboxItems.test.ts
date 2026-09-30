import type { ViewRegistration } from "@intentic/extension-api";
import type { AgentAttention, AutomationApproval, Need, PendingWorkspaceExtension } from "@intentic/sandbox-contract";
import { chatItem, type InboxItem, inboxBadge, inboxOrder, inboxSections, installItem, needItem, nextAfter, viewItem, waitingWakes, wakeItem } from "./inboxItems";

// The one list Needs you draws and the rail counts: which group each source lands in, the order it is read in, where
// the selection goes when the answered item leaves, and what the tile says about it.

const none: AgentAttention = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const need = (id: string, createdAt: number, status: Need[`status`] = `open`): Need => ({
    id,
    conversationId: `c-${id}`,
    subject: { kind: `secret`, name: `STRIPE_KEY` },
    title: `The STRIPE_KEY secret`,
    status,
    createdAt,
    updatedAt: createdAt,
});

const wake = (id: string, createdAt: number, autoRunAt?: number): AutomationApproval =>
    autoRunAt === undefined ? { id, automationId: `nightly`, createdAt } : { id, automationId: `nightly`, createdAt, autoRunAt };

const view: ViewRegistration = { id: `approvals`, label: `Approvals`, surface: `rail`, detect: () => [], view: async () => await Promise.resolve({}) };

describe(`what lands where`, () => {
    it(`holds a need up as blocking only while its conversation has stopped on it`, () => {
        expect(needItem(need(`n1`, 1), { title: `Checkout`, status: `idle` }).group).toBe(`blocking`);
        expect(needItem(need(`n1`, 1), { title: `Checkout`, status: `running` }).group).toBe(`waiting`);
        // Said yes to and being set up: nothing left for a person to do but wait.
        expect(needItem(need(`n1`, 1, `working`), { title: `Checkout`, status: `idle` }).group).toBe(`waiting`);
        // A conversation the board no longer lists has no turn to stop.
        expect(needItem(need(`n1`, 1), undefined)).toMatchObject({ group: `waiting`, context: `A conversation` });
    });

    it(`names a need by its kind and the conversation that asked`, () => {
        expect(needItem(need(`n1`, 1), { title: `Checkout`, status: `idle` })).toMatchObject({
            key: `need:n1`,
            kind: `Secret`,
            icon: `key`,
            title: `The STRIPE_KEY secret`,
            context: `Checkout`,
        });
    });

    it(`files a parked turn as blocking, named by what it is parked on`, () => {
        const item = chatItem({ id: `a1`, title: `Fix login`, status: `idle`, attention: { ...none, permission: true }, updatedAt: 5 });
        expect(item).toMatchObject({ key: `chat:a1`, kind: `Permission`, icon: `shield`, title: `Fix login`, group: `blocking`, createdAt: 5 });
        // A hand-off raises no flag: it arrives as a bare `awaiting`.
        expect(chatItem({ id: `a2`, status: `awaiting`, attention: none, updatedAt: 5 })).toMatchObject({ kind: `Waiting on you`, icon: `comments` });
        // Its open need is listed as itself, so the chat's row says what the chat is asking, not "Needs you".
        expect(chatItem({ id: `a3`, status: `idle`, attention: { ...none, need: true, question: true }, updatedAt: 5 })).toMatchObject({
            kind: `Question for you`,
            icon: `question-circle`,
        });
    });

    it(`lists only the held wakes nobody's countdown will release`, () => {
        expect(waitingWakes([wake(`w1`, 1), wake(`w2`, 2, 99)]).map((held) => held.id)).toEqual([`w1`]);
        expect(wakeItem(wake(`w1`, 1))).toMatchObject({ key: `wake:w1`, kind: `Automation`, title: `nightly`, group: `waiting` });
    });

    it(`says whether an extension is new or asking for more`, () => {
        // SAFETY: installItem reads only the id, the folder and whether it was approved before; the manifest, powers and
        // digest are the Extensions tab's to read.
        const pending = { id: `acme.notes`, dir: `notes`, approvedBefore: false } as PendingWorkspaceExtension;
        expect(installItem(pending).title).toBe(`Let acme.notes run`);
        expect(installItem({ ...pending, approvedBefore: true }).title).toBe(`acme.notes asks for more`);
    });

    it(`says an extension's ask under its view's name, and falls back to a known glyph`, () => {
        const item = viewItem(view, { id: `p1`, kind: `Post`, title: `Launch post`, context: `Discord`, icon: `no-such-glyph`, tone: `danger`, open: `/ext/approvals` });
        expect(item).toMatchObject({ key: `view:approvals:p1`, kind: `Post`, context: `Approvals · Discord`, icon: `check-square`, broken: true });
        expect(viewItem(view, { id: `p2`, kind: `Hooks`, title: `Let 2 hooks run`, icon: `shield`, open: `/ext/approvals` }).context).toBe(`Approvals`);
    });
});

describe(`the order it is read in`, () => {
    const blockingOld = needItem(need(`old`, 1), { status: `idle` });
    const blockingNew = needItem(need(`new`, 9), { status: `idle` });
    const waiting = wakeItem(wake(`w`, 0));
    const broken = viewItem(view, { id: `f`, kind: `Post`, title: `Failed`, tone: `danger`, createdAt: 50, open: `/ext/approvals` });
    const undated = viewItem(view, { id: `u`, kind: `Hooks`, title: `Hooks`, open: `/ext/approvals` });

    it(`leads with what blocks an agent, then what waited longest, a broken one first in its group and an undated one last`, () => {
        const sections = inboxSections([undated, waiting, blockingNew, broken, blockingOld]);
        expect(sections.map((section) => [section.group, section.items.map((item) => item.key)])).toEqual([
            [`blocking`, [`need:old`, `need:new`]],
            [`waiting`, [`view:approvals:f`, `wake:w`, `view:approvals:u`]],
        ]);
    });

    it(`draws no heading for an empty group`, () => {
        expect(inboxSections([waiting]).map((section) => section.group)).toEqual([`waiting`]);
        expect(inboxSections([])).toEqual([]);
    });

    it(`moves the selection to what took the answered one's place, else the one before it`, () => {
        const before = inboxOrder([blockingOld, blockingNew, waiting]);
        expect(nextAfter(before, inboxOrder([blockingOld, waiting]), `need:new`)).toBe(`wake:w`);
        expect(nextAfter(before, inboxOrder([blockingOld, blockingNew]), `wake:w`)).toBe(`need:new`);
        expect(nextAfter(before, [], `wake:w`)).toBeUndefined();
    });
});

describe(`the one count`, () => {
    const items = (...list: InboxItem[]): readonly InboxItem[] => list;

    it(`draws nothing while nothing waits`, () => {
        expect(inboxBadge([])).toBeUndefined();
    });

    it(`rests at info, warns while an agent is stopped on one, and turns danger while one already broke`, () => {
        const waiting = wakeItem(wake(`w`, 0));
        expect(inboxBadge(items(waiting))).toEqual({ count: 1, tone: `info`, tooltip: `1 waiting` });
        expect(inboxBadge(items(waiting, needItem(need(`n`, 1), { status: `idle` })))).toEqual({
            count: 2,
            tone: `warning`,
            tooltip: `2 waiting, 1 blocking an agent`,
        });
        const broken = viewItem(view, { id: `f`, kind: `Post`, title: `Failed`, tone: `danger`, open: `/ext/approvals` });
        expect(inboxBadge(items(waiting, broken))?.tone).toBe(`danger`);
    });
});
