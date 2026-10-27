import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import { type FleetAgent, laneGroups } from "../useAgents-fleet";
import { activeGroups, activePhase, goesAt } from "./activePhase";
import { foldChildren } from "./childFold";

// Pins the Active lane's one order: what is working, newest started first; then what goes by itself, soonest first;
// then drafts, newest first. A twenty-card lane sorted by "drafts, then turn start" interleaved a draft, a running turn,
// a message booked for 3am and another running turn, and read as no order at all (2026-10-26).

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const running = (id: string, startedAt: number): FleetAgent => card(id, { status: `running`, startedAt });
const booked = (id: string, at: number): FleetAgent => card(id, { next: { kind: `send`, at, count: 1 } });
const resend = (id: string, at: number): FleetAgent => card(id, { status: `error`, failureCode: `rate_limit`, next: { kind: `rerun`, at } });
const draft = (id: string, draftAt = 0): FleetAgent => card(id, { status: `draft`, updatedAt: 0, draftAt });
const watch = (id: string, deadlineAt: number): FleetAgent =>
    card(id, { awaitingWake: true, watches: [{ id: `w-${id}`, note: `ci`, intervalSeconds: 60, deadlineAt }] });
const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);

describe(`the Active lane's order`, () => {
    test(`working, then what goes by itself, then drafts, whatever order they came in`, () => {
        const lane = laneGroups([draft(`d`, 50), booked(`b`, 9_000), running(`r`, 100), resend(`l`, 8_000)]).active;
        expect(ids(lane)).toEqual([`r`, `l`, `b`, `d`]);
    });

    test(`working cards read newest started first, and a turn's clock never moves while it streams`, () => {
        const lane = laneGroups([running(`old`, 100), running(`new`, 300), running(`mid`, 200)]).active;
        expect(ids(lane)).toEqual([`new`, `mid`, `old`]);
        const ticked = laneGroups([running(`old`, 100), { ...running(`new`, 300), updatedAt: 99_000 }, running(`mid`, 200)]).active;
        expect(ids(ticked)).toEqual([`new`, `mid`, `old`]);
    });

    test(`what goes by itself reads as a timetable: soonest first, then what names no time`, () => {
        const room = card(`room`, { next: { kind: `room` } });
        const lane = laneGroups([room, booked(`late`, 9_000), watch(`w`, 5_000), resend(`soon`, 2_000)]).active;
        expect(ids(lane)).toEqual([`soon`, `w`, `late`, `room`]);
    });

    test(`drafts read newest written first`, () => {
        expect(ids(laneGroups([draft(`a`, 10), draft(`b`, 30), draft(`c`, 20)]).active)).toEqual([`b`, `c`, `a`]);
    });

    test(`a turn in flight is working even with a message booked behind it`, () => {
        expect(activePhase({ ...booked(`b`, 9_000), status: `running` })).toBe(`working`);
    });

    test(`a family lifted into Active by a child working under it reads as working`, () => {
        const parent = card(`p`, { status: `landed`, updatedAt: 500 });
        const child = { ...running(`c`, 400), startedBy: `agent:p` };
        const lane = foldChildren(laneGroups([parent, child, booked(`b`, 9_000), running(`r`, 100)])).lanes.active;
        expect(ids(lane)).toEqual([`p`, `r`, `b`]);
        expect(activePhase(parent)).toBe(`working`);
    });

    test(`goesAt names the soonest instant its corner promises`, () => {
        expect(goesAt(booked(`b`, 9_000))).toBe(9_000);
        expect(goesAt({ ...booked(`b`, 9_000), watches: [{ id: `w`, note: `ci`, intervalSeconds: 60, deadlineAt: 4_000 }] })).toBe(4_000);
        expect(goesAt(card(`room`, { next: { kind: `room` } }))).toBe(Number.POSITIVE_INFINITY);
    });
});

describe(`the Active lane's groups`, () => {
    test(`one group per phase present, in the lane's order, each keeping the order it came in`, () => {
        const groups = activeGroups([running(`r2`, 2), running(`r1`, 1), booked(`b`, 9_000), draft(`d`)]);
        expect(groups.map((group) => [group.phase, ids(group.cards)])).toEqual([
            [`working`, [`r2`, `r1`]],
            [`next`, [`b`]],
            [`draft`, [`d`]],
        ]);
    });

    test(`a phase with nothing in it draws no group`, () => {
        expect(activeGroups([running(`r`, 1), draft(`d`)]).map((group) => group.phase)).toEqual([`working`, `draft`]);
    });
});
