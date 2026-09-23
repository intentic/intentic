import { HOSTED_IDLE, type HostedEvent, type HostedLane, laneBusy, owesHandBack, stepHosted } from "./hostedLane";

// Pins every move the hosted lane can make, and every event a lane refuses, as values: a start is taken only from
// idle, an answer only under the action it started with, a hand-back supersedes anything in flight, and what the
// platform was asked for is remembered until it settles.

const idle = (asked: HostedLane[`asked`], action = 4): HostedLane => ({ kind: `idle`, action, asked });
const provisioning: HostedLane = { kind: `provisioning`, action: 5, asked: `machine` };
const restarting: HostedLane = { kind: `restarting`, action: 5, asked: `nothing` };
const releasing: HostedLane = { kind: `releasing`, action: 5, asked: `release` };

describe(`the hosted lane`, () => {
    it.each<[string, HostedLane, HostedEvent, HostedLane]>([
        [`starts a provision from idle, asking for a machine`, idle(`nothing`), { kind: `provision` }, provisioning],
        [
            `keeps an unconfirmed hand-back asked for across a new provision`,
            idle(`release`),
            { kind: `provision` },
            { kind: `provisioning`, action: 5, asked: `release` },
        ],
        [`starts a restart from idle, asking for nothing new`, idle(`nothing`), { kind: `restart` }, restarting],
        [`restarts a machine this visit asked for`, idle(`machine`), { kind: `restart` }, { kind: `restarting`, action: 5, asked: `machine` }],
        [`settles a provision under its own action`, provisioning, { kind: `settled`, action: 5 }, idle(`machine`, 5)],
        [`settles a restart under its own action`, restarting, { kind: `settled`, action: 5 }, idle(`nothing`, 5)],
        [`hands back from idle`, idle(`machine`), { kind: `release` }, releasing],
        [`hands back over a provision in flight`, provisioning, { kind: `release` }, { kind: `releasing`, action: 6, asked: `release` }],
        [`hands back over a restart in flight`, restarting, { kind: `release` }, { kind: `releasing`, action: 6, asked: `release` }],
        [`forgets everything asked once the hand-back is confirmed`, releasing, { kind: `released` }, idle(`nothing`, 5)],
        [`keeps the hand-back asked for when the platform refuses it`, releasing, { kind: `refused` }, idle(`release`, 5)],
        [`moves the action on when the page goes away, and nothing else`, provisioning, { kind: `left` }, { ...provisioning, action: 6 }],
        [`moves an idle lane's action on as well`, idle(`release`), { kind: `left` }, idle(`release`, 5)],
    ])(`%s`, (_, lane, event, next) => {
        expect(stepHosted(lane, event)).toEqual(next);
    });

    it.each<[string, HostedLane, HostedEvent]>([
        [`a second provision while one is in flight`, provisioning, { kind: `provision` }],
        [`a provision during a restart`, restarting, { kind: `provision` }],
        [`a provision during a hand-back`, releasing, { kind: `provision` }],
        [`a restart during a provision`, provisioning, { kind: `restart` }],
        [`a restart during a hand-back`, releasing, { kind: `restart` }],
        [`a provision's answer under an older action`, provisioning, { kind: `settled`, action: 4 }],
        [`a stale answer arriving over the hand-back that superseded it`, releasing, { kind: `settled`, action: 5 }],
        [`an answer with nothing in flight`, idle(`machine`, 5), { kind: `settled`, action: 5 }],
        [`a confirmed hand-back that is not in flight`, provisioning, { kind: `released` }],
        [`a refused hand-back that is not in flight`, idle(`machine`), { kind: `refused` }],
    ])(`refuses %s`, (_, lane, event) => {
        expect(stepHosted(lane, event)).toBe(lane);
    });

    it(`starts from nothing asked, under action zero`, () => {
        expect(HOSTED_IDLE).toEqual({ kind: `idle`, action: 0, asked: `nothing` });
    });

    it(`reads busy for a provision or a restart only`, () => {
        expect([idle(`machine`), provisioning, restarting, releasing].map(laneBusy)).toEqual([false, true, true, false]);
    });

    it(`owes a hand-back for anything asked or in flight, and never for a clean idle lane`, () => {
        expect([idle(`nothing`), idle(`machine`), idle(`release`), provisioning, restarting, releasing].map(owesHandBack)).toEqual([
            false,
            true,
            true,
            true,
            true,
            true,
        ]);
    });
});
