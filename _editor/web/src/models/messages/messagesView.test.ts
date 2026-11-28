import type { S2sContact, S2sContactTask, S2sOutboxEntry, S2sThreadMessage, S2sThreadSummary } from "@intentic/sandbox-contract/schemas/s2s";
import { S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import {
    contactSections,
    contactsBadge,
    deliveryMark,
    fingerprintGroups,
    hasUnread,
    messageable,
    messagesBadge,
    noticeTone,
    outboxLine,
    shortFingerprint,
    taskName,
    tasksOfContact,
    threadDays,
    threadsInOrder,
    unreadThreads,
    waitingTasks,
} from "./messagesView";

// What the Messages tab works out from the daemon's answers before drawing anything: its badge, the order of threads and
// contacts, a thread's days and runs, how a sent message stands, the outbox's one line, and a fingerprint read aloud.

const FP = `isk1:${`abcd`.repeat(13)}`;
const DAY = 24 * 3_600_000;
// Noon on a fixed day, local time, so a run of messages never straddles a midnight by accident.
const NOON = new Date(2026, 10, 20, 12, 0, 0).getTime();

const summary = (id: string, unread: number, at: number): S2sThreadSummary => ({
    id,
    contact: `c-${id}`,
    contactName: id,
    scope: { kind: `sandbox` },
    last: { at, direction: `in`, preview: `…` },
    unread,
    messages: 3,
    undelivered: 0,
});

let ids = 0;
const message = (direction: `in` | `out`, at: number, extra: Partial<Pick<S2sThreadMessage, `read` | `delivery` | `receivedAt`>> = {}): S2sThreadMessage => {
    const made: S2sThreadMessage = {
        id: `0190a5b2-0000-7000-8000-${String((ids += 1)).padStart(12, `0`)}`,
        thread: `t1`,
        contact: `c1`,
        direction,
        kind: `message`,
        text: `at ${at}`,
        attachments: [],
        sentAt: at,
        read: extra.read ?? true,
    };
    if (extra.receivedAt !== undefined) {
        made.receivedAt = extra.receivedAt;
    }
    if (extra.delivery !== undefined) {
        made.delivery = extra.delivery;
    }
    return made;
};

const contact = (name: string, state: S2sContact[`state`], createdAt = 0): S2sContact => ({
    id: name,
    address: `${name}.intentic.app`,
    name,
    host: `${name}.intentic.app`,
    domains: [],
    fingerprint: FP,
    scope: { kind: `sandbox` },
    state,
    grants: S2sGrantsSchema.parse({}),
    holdsWake: false,
    notices: [],
    origin: `request`,
    createdAt,
    updatedAt: createdAt,
});

const task = (requestId: string, state: S2sContactTask[`state`], askedAt: number, more: Partial<S2sContactTask> = {}): S2sContactTask => ({
    contact: `research`,
    contactName: `research-desk`,
    requestId,
    conversationId: `link-${requestId}`,
    state,
    askedAt,
    updatedAt: askedAt,
    ...more,
});

it(`badges threads with something unread, not the messages in them, plus the requests waiting`, () => {
    const threads = [summary(`a`, 4, 1), summary(`b`, 0, 2), summary(`c`, 1, 3)];
    expect(unreadThreads(threads)).toBe(2);
    expect(messagesBadge({ threads, requests: 3 })).toBe(5);
    expect(messagesBadge({ threads: [], requests: 0 })).toBe(0);
    expect(messagesBadge(undefined)).toBe(0);
});

it(`badges the contacts' tasks that wait for the owner, and none that run or settled`, () => {
    const threads = [summary(`a`, 4, 1), summary(`b`, 0, 2)];
    const tasks = [task(`a`, `held`, 1), task(`b`, `running`, 2), task(`c`, `held`, 3), task(`d`, `declined`, 4), task(`e`, `finished`, 5)];
    expect(messagesBadge({ threads, requests: 3 }, tasks)).toBe(6);
    expect(contactsBadge(3, tasks)).toBe(5);
    expect(contactsBadge(0, [task(`f`, `running`, 1), task(`g`, `failed`, 2), task(`h`, `stopped`, 3)])).toBe(0);
    // Read before the threads are: the tasks still count.
    expect(messagesBadge(undefined, tasks)).toBe(2);
});

it(`lists the tasks waiting for the owner oldest first, the longest kept waiting leading`, () => {
    const tasks = [task(`late`, `held`, 30), task(`running`, `running`, 5), task(`early`, `held`, 10), task(`gone`, `declined`, 1)];
    expect(waitingTasks(tasks).map((each) => each.requestId)).toEqual([`early`, `late`]);
    expect(waitingTasks([])).toEqual([]);
});

it(`lists one contact's tasks: waiting first, then running, then settled, each newest first`, () => {
    const tasks = [
        task(`old-done`, `finished`, 10),
        task(`waiting`, `held`, 20),
        task(`other`, `held`, 50, { contact: `billing` }),
        task(`new-failed`, `failed`, 40),
        task(`running`, `running`, 15),
    ];
    expect(tasksOfContact(tasks, `research`).map((each) => each.requestId)).toEqual([`waiting`, `running`, `new-failed`, `old-done`]);
    expect(tasksOfContact(tasks, `nobody`)).toEqual([]);
});

it(`names a task by its title, else its first line of words, else not at all`, () => {
    expect(taskName(task(`a`, `held`, 1, { title: `  Churn by cohort  `, task: `ignored` }))).toBe(`Churn by cohort`);
    expect(taskName(task(`b`, `held`, 1, { title: ` `, task: `\n  Pull the orders  \nand split them` }))).toBe(`Pull the orders`);
    expect(taskName(task(`c`, `held`, 1, { task: `x`.repeat(130) }))).toBe(`${`x`.repeat(119)}…`);
    expect(taskName(task(`d`, `held`, 1, { task: `x`.repeat(120) }))).toBe(`x`.repeat(120));
    expect(taskName(task(`e`, `running`, 1))).toBeUndefined();
});

it(`lists threads newest first`, () => {
    expect(threadsInOrder([summary(`old`, 0, 10), summary(`new`, 0, 30), summary(`mid`, 0, 20)]).map((thread) => thread.id)).toEqual([`new`, `mid`, `old`]);
});

it(`reads a thread oldest first, in days, saying a sender once per run`, () => {
    const days = threadDays([
        message(`out`, NOON + 2 * 60_000),
        message(`in`, NOON - DAY),
        message(`in`, NOON),
        message(`in`, NOON + 60_000),
        // Past the run's ten minutes from the one before: names its sender again.
        message(`out`, NOON + 30 * 60_000),
    ]);
    expect(days.map((day) => day.messages.map((each) => [each.direction, each.sentAt - NOON]))).toEqual([
        [[`in`, -DAY]],
        [
            [`in`, 0],
            [`in`, 60_000],
            [`out`, 2 * 60_000],
            [`out`, 30 * 60_000],
        ],
    ]);
    expect(days.map((day) => day.opens)).toEqual([[true], [true, false, true, true]]);
    expect(days[1]?.day).toBe(new Date(2026, 10, 20).getTime());
});

it(`orders a received message by when it arrived, not when its sender stamped it`, () => {
    const late = message(`in`, NOON - 60 * 60_000, { receivedAt: NOON + 5 * 60_000 });
    const days = threadDays([late, message(`out`, NOON)]);
    expect(days[0]?.messages.map((each) => each.direction)).toEqual([`out`, `in`]);
});

it(`marks read on open only while a received message is unread`, () => {
    expect(hasUnread([message(`in`, 1, { read: false })])).toBe(true);
    expect(hasUnread([message(`out`, 1, { read: false }), message(`in`, 2)])).toBe(false);
});

it(`marks a sent message by its delivery, and a received one not at all`, () => {
    expect(deliveryMark(message(`out`, 1, { delivery: { state: `queued`, attempts: 2 } }))).toBe(`queued`);
    expect(deliveryMark(message(`out`, 1, { delivery: { state: `undelivered`, attempts: 9, reason: `refused` } }))).toBe(`undelivered`);
    // A sent message the daemon gave no delivery for was taken: nothing waits on it.
    expect(deliveryMark(message(`out`, 1))).toBe(`sent`);
    expect(deliveryMark(message(`in`, 1))).toBeUndefined();
});

it(`says how many wait in the outbox, why the oldest waits, and when the next try is`, () => {
    const entry = (id: string, state: S2sOutboxEntry[`state`], firstAt: number, more: Partial<S2sOutboxEntry> = {}): S2sOutboxEntry => ({
        id: `0190a5b2-0000-7000-8000-00000000000${id}`,
        contact: `c1`,
        contactName: `research`,
        kind: `message`,
        state,
        attempts: 3,
        firstAt,
        ...more,
    });
    expect(outboxLine([])).toBeUndefined();
    expect(
        outboxLine([
            entry(`1`, `waiting`, 20, { nextAt: 900, lastError: `asleep` }),
            entry(`2`, `waiting`, 10, { nextAt: 500, lastError: `no answer` }),
            entry(`3`, `undelivered`, 5),
        ]),
    ).toEqual({ waiting: 2, undelivered: 1, reason: `no answer`, next: 500 });
    expect(outboxLine([entry(`4`, `undelivered`, 1)])).toEqual({ waiting: 0, undelivered: 1, reason: undefined, next: undefined });
});

it(`puts requests waiting on a person first, oldest first, then contacts by name, blocked ones last`, () => {
    const sections = contactSections([
        contact(`zed`, `accepted`),
        contact(`late`, `pending-in`, 20),
        contact(`spam`, `blocked`),
        contact(`ada`, `key-changed`),
        contact(`early`, `pending-in`, 10),
        contact(`bob`, `pending-out`),
    ]);
    expect([sections.waiting, sections.known, sections.blocked].map((list) => list.map((each) => each.name))).toEqual([
        [`early`, `late`],
        [`ada`, `bob`, `zed`],
        [`spam`],
    ]);
    expect(messageable([contact(`a`, `accepted`), contact(`b`, `key-changed`), contact(`c`, `pending-out`)]).map((each) => each.name)).toEqual([`a`]);
});

it(`warns of a key vouched for only by its domain, and of a removal; tells of the rest`, () => {
    expect(noticeTone({ kind: `rekeyed-by-domain`, at: 1, seen: false })).toBe(`warning`);
    expect(noticeTone({ kind: `removed`, at: 1, seen: false })).toBe(`warning`);
    expect(noticeTone({ kind: `rotated`, at: 1, seen: false })).toBe(`info`);
    expect(noticeTone({ kind: `recovered`, at: 1, seen: false })).toBe(`info`);
});

it(`groups a fingerprint in fours to compare aloud, and keeps one it does not know whole`, () => {
    const real = `isk1:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst`;
    const { prefix, groups } = fingerprintGroups(real);
    expect(prefix).toBe(`isk1:`);
    expect(groups).toHaveLength(13);
    expect(groups.slice(0, 3)).toEqual([`abcd`, `efgh`, `ijkl`]);
    expect(`${prefix}${groups.join(``)}`).toBe(real);
    expect(fingerprintGroups(`nocolon`)).toEqual({ prefix: ``, groups: [`nocolon`] });
    expect(shortFingerprint(real)).toBe(`isk1:abcd efgh…`);
});
