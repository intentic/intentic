import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { HeldEnding } from "@intentic/sandbox-contract/schemas/turn-break";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../agent-status/agentStatus-standing";
import { spentUntilOf } from "../accounts/runServing";
import { LIMIT_COOLDOWN_MS, type PickUp, pickUpReady } from "./pickUp";
import { cardPressWay, goesAtReopen, type PressFacts, pressGoes, pressWayOf } from "./pressWay";

/* THE PRESS ON A TURN THAT STOPPED SHORT, AGAINST THE ACCOUNT IT WOULD RUN ON (pressWay.ts). The same spent allowance with
   no known reset got three answers before: the strip's Continue greyed under "awaiting reset" for a reset nobody knew,
   the board card's Send again enabled, and typed words sent anyway. Pinned here over every ending, held or not, every
   reading of the account, the access wall, the rest after a refusal, and the sandbox answering or not. */

const NOW = 1_800_000_000_000;
const AHEAD = NOW + 2 * 3_600_000;
const PAST = NOW - 60_000;
const s = (ms: number): number => Math.round(ms / 1_000);

const REASONS: readonly HeldEnding[] = [`limit`, `stopped`, `outage`, `flagged`];

// A pick-up with whichever of its optional facts are given.
const pickUpWith = (reason: HeldEnding, held: { readonly ran: boolean } | undefined, readyAt: number | undefined, coolUntil?: number): PickUp => {
    let pickUp: PickUp = { reason };
    if (held !== undefined) {
        pickUp = { ...pickUp, held };
    }
    if (readyAt !== undefined) {
        pickUp = { ...pickUp, readyAt };
    }
    return coolUntil === undefined ? pickUp : { ...pickUp, coolUntil };
};
const HELDS = [undefined, { ran: true }, { ran: false }] as const;
const named = (at: number | undefined): string => (at === undefined ? `none` : at > NOW ? `ahead` : `past`);

// Every pick-up a strip can show: each ending, held or not, an allowance's own reset ahead, past or unknown, resting
// after a refusal where nothing ran or not.
const pickUps = (): readonly { readonly name: string; readonly pickUp: PickUp }[] =>
    REASONS.flatMap((reason) =>
        HELDS.flatMap((held) =>
            [undefined, AHEAD, PAST].flatMap((readyAt) =>
                [undefined, NOW + LIMIT_COOLDOWN_MS].map((coolUntil) => ({
                    name: `${reason} held=${JSON.stringify(held)} reset=${named(readyAt)} cooling=${coolUntil !== undefined}`,
                    pickUp: pickUpWith(reason, held, readyAt, coolUntil),
                })),
            ),
        ),
    );

// Every reading of the account the press would run on, each with the reopen the composer reads off it (spentUntilOf).
const STATES: ReadonlyMap<string, AccountState | undefined> = new Map<string, AccountState | undefined>([
    [`none read`, undefined],
    [`ready`, { kind: `ready`, room: 40 }],
    [`unknown`, { kind: `unknown` }],
    [`spent, reopen ahead`, { kind: `spent`, reopensAt: s(AHEAD) }],
    [`spent, reopen past`, { kind: `spent`, reopensAt: s(PAST) }],
    [`spent, no reopen`, { kind: `spent` }],
    [`blocked, reconnect`, { kind: `blocked`, fix: `reconnect`, reason: `signed out` }],
    [`blocked, admin`, { kind: `blocked`, fix: `admin`, reason: `seat removed` }],
    [`blocked, verify`, { kind: `blocked`, fix: `verify`, reason: `verify the account`, url: `https://example.test` }],
    [`blocked, wait with no end`, { kind: `blocked`, fix: `wait`, reason: `suspended` }],
    [`blocked, wait until ahead`, { kind: `blocked`, fix: `wait`, reason: `suspended`, until: s(AHEAD) }],
]);

interface PressCase {
    readonly name: string;
    readonly facts: PressFacts;
}

const cases = (): readonly PressCase[] => {
    const all: PressCase[] = [];
    for (const { name, pickUp } of pickUps()) {
        for (const [stateName, state] of STATES) {
            for (const accessWall of [false, true]) {
                const facts = { pickUp, state, spentUntil: spentUntilOf(state, NOW), accessWall, now: NOW };
                all.push(
                    ...[
                        { reachable: true, continuing: false },
                        { reachable: false, continuing: false },
                        { reachable: true, continuing: true },
                    ].map((live) => ({ name: `${name} / ${stateName} / wall=${accessWall} / ${JSON.stringify(live)}`, facts: { ...facts, ...live } })),
                );
            }
        }
    }
    return all;
};

const cooling = (facts: PressFacts): boolean => facts.pickUp.coolUntil !== undefined && facts.now < facts.pickUp.coolUntil;

describe(`the strip's press`, () => {
    const all = cases();

    // THE INVARIANT: the strip always offers a press that goes, unless this window rests after a refusal where nothing
    // ran, the sandbox does not answer, a press is already under way, or the access wall's own controls stand for it.
    test(`always goes, unless resting, unreachable, already going, or the access wall's own controls stand for it`, () => {
        const wrong = all.flatMap(({ name, facts }) => {
            const way = pressWayOf(facts);
            const kept = cooling(facts) || !facts.reachable || facts.continuing;
            const offered = way.kind === `wall` || way.enabled;
            const problems = [
                ...(offered || kept ? [] : [`no press goes`]),
                ...(way.enabled === !kept ? [] : [`enabled=${way.enabled} while kept=${kept}`]),
                ...(way.kind === `wall` && !facts.accessWall ? [`a wall nobody read`] : []),
                ...(facts.accessWall && way.kind !== `wall` ? [`the access wall's own controls left out`] : []),
            ];
            return problems.map((problem) => `${name}: ${problem}`);
        });
        expect(wrong).toEqual([]);
        expect(all.length).toBe(REASONS.length * 3 * 3 * 2 * STATES.size * 2 * 3);
    });

    test(`says why it waits, in the order a reader can do something about`, () => {
        const pickUp: PickUp = { reason: `limit`, held: { ran: false }, coolUntil: NOW + 1_000 };
        const base = { pickUp, state: undefined, spentUntil: undefined, accessWall: false, now: NOW };
        expect(pressWayOf({ ...base, reachable: false, continuing: true }).rest).toBe(`unreachable`);
        expect(pressWayOf({ ...base, reachable: true, continuing: true }).rest).toBe(`continuing`);
        expect(pressWayOf({ ...base, reachable: true, continuing: false }).rest).toBe(`cooling`);
        expect(pressWayOf({ ...base, reachable: true, continuing: false, now: NOW + 1_000 })).toEqual({ kind: `continue`, enabled: true });
    });

    // Which press it is, by what is in the way of the account it runs on.
    test.each([
        [`spent, reopen ahead`, { kind: `tryThenAt`, at: s(AHEAD) * 1_000 }],
        [`blocked, wait until ahead`, { kind: `tryThenAt`, at: s(AHEAD) * 1_000 }],
        [`spent, no reopen`, { kind: `try`, reading: `spent` }],
        [`blocked, reconnect`, { kind: `try`, reading: `reconnect` }],
        [`blocked, admin`, { kind: `try`, reading: `admin` }],
        [`blocked, verify`, { kind: `try`, reading: `verify` }],
        [`blocked, wait with no end`, { kind: `try`, reading: `wait` }],
        [`spent, reopen past`, { kind: `continue` }],
        [`ready`, { kind: `continue` }],
        [`unknown`, { kind: `continue` }],
        [`none read`, { kind: `continue` }],
    ] as const)(`on an account reading %s, a stopped turn's press is %o`, (stateName, way) => {
        const state = STATES.get(stateName);
        const facts = { pickUp: { reason: `stopped`, held: { ran: true } }, state, spentUntil: spentUntilOf(state, NOW), accessWall: false, reachable: true, continuing: false, now: NOW } as const;
        expect(pressWayOf(facts)).toEqual({ ...way, enabled: true });
    });

    // The Cursor, Grok and Devin case: a spent allowance that names no reset. It used to be a greyed Continue under
    // "awaiting reset", for a reset nobody knew.
    test(`tries a spent allowance with no reset now, naming the reading`, () => {
        for (const held of [undefined, { ran: true }, { ran: false }]) {
            const pickUp: PickUp = held === undefined ? { reason: `limit` } : { reason: `limit`, held };
            expect(pressWayOf({ pickUp, state: { kind: `spent` }, spentUntil: undefined, accessWall: false, reachable: true, continuing: false, now: NOW })).toEqual({
                kind: `try`,
                reading: `spent`,
                enabled: true,
            });
        }
    });

    // An unheld allowance's own reset still ahead, with nothing read that says the account has room: the press carries
    // the session on into the same wall, a try; once something reads room, a plain Continue.
    test(`tries an unheld allowance before its own reset, and continues once the account reads room`, () => {
        const pickUp: PickUp = { reason: `limit`, readyAt: AHEAD };
        const facts = { pickUp, spentUntil: undefined, accessWall: false, reachable: true, continuing: false, now: NOW };
        expect(pressWayOf({ ...facts, state: undefined })).toEqual({ kind: `try`, at: AHEAD, enabled: true });
        expect(pressWayOf({ ...facts, state: { kind: `unknown` } })).toEqual({ kind: `try`, at: AHEAD, enabled: true });
        expect(pressWayOf({ ...facts, state: { kind: `ready`, room: 50 } })).toEqual({ kind: `continue`, enabled: true });
        // Held, it re-runs whatever the reset says.
        expect(pressWayOf({ ...facts, pickUp: { ...pickUp, held: { ran: true } }, state: undefined })).toEqual({ kind: `continue`, enabled: true });
    });

    test(`leaves a flagged turn its own presses, and the access wall its own controls`, () => {
        const facts = { state: { kind: `spent` } as const, spentUntil: undefined, reachable: true, continuing: false, now: NOW };
        expect(pressWayOf({ ...facts, pickUp: { reason: `flagged`, held: { ran: true } }, accessWall: false })).toEqual({ kind: `flagged`, enabled: true });
        expect(pressWayOf({ ...facts, pickUp: { reason: `flagged`, held: { ran: true } }, accessWall: true })).toEqual({ kind: `wall`, enabled: true });
        expect(pressWayOf({ ...facts, pickUp: { reason: `stopped` }, accessWall: true })).toEqual({ kind: `wall`, enabled: true });
    });

    // The bare Enter is not this press: it keeps composerIntent's stricter offer (continueOffered reads pickUpReady and
    // the account), which this rule never loosens. Where the strip's press goes and the bare one would not, the strip is
    // the only way, and it is there.
    test(`goes wherever the bare press's reading would, and further`, () => {
        const wrong = all.flatMap(({ name, facts }) => {
            const bareWould = pickUpReady(facts.pickUp, facts.now) && facts.spentUntil === undefined && facts.reachable && !facts.continuing;
            return bareWould && !pressGoes(facts.pickUp, facts.reachable, facts.continuing, facts.now) ? [name] : [];
        });
        expect(wrong).toEqual([]);
    });

    test(`reads the composer's press exactly as the strip's`, () => {
        const wrong = all.flatMap(({ name, facts }) => (pressGoes(facts.pickUp, facts.reachable, facts.continuing, facts.now) === pressWayOf(facts).enabled ? [] : [name]));
        expect(wrong).toEqual([]);
        expect(pressGoes(undefined, true, false, NOW)).toBe(false);
    });
});

/* THE BOARD CARD AGREES. Its press for a turn a spent allowance stranded (cardRequests.ts: Send again, or Send at reset)
   is the same rule weighed against the one reading the card has, the daemon's reopen for where the hold goes. For every
   such turn and every reopen, the card's press goes at the reopen exactly where the strip's solid press does, given that
   reopen, and goes now exactly where the strip's does. */

const cardOf = (more: Partial<AgentStanding>): AgentStanding => ({ status: `error`, failureCode: `rate_limit`, attention: NO_ATTENTION, ...more });

// A stranded card as the daemon states it: its reset (s) and hold on the limit fields, and, from a sandbox that says it,
// the same ending as its press.
const strandedCard = (held: { readonly ran: boolean } | undefined, limitResetsAt: number | undefined, fromPress: boolean): AgentStanding => {
    let card = cardOf({});
    if (limitResetsAt !== undefined) {
        card = { ...card, limitResetsAt };
    }
    if (held !== undefined) {
        card = { ...card, limitHeld: true };
    }
    const ending = pickUpWith(`limit`, held, undefined);
    return fromPress ? { ...card, press: { kind: `continue`, ending: limitResetsAt === undefined ? ending : { ...ending, resetsAt: limitResetsAt } } } : card;
};

describe(`the board card's press`, () => {
    test(`goes at the reopen exactly where the strip's solid press does, and now where the strip's does`, () => {
        const wrong: string[] = [];
        for (const held of HELDS) {
            for (const reset of [undefined, AHEAD, PAST]) {
                for (const fromPress of [false, true]) {
                    const limitResetsAt = reset === undefined ? undefined : s(reset);
                    const cardWay = cardPressWay(strandedCard(held, limitResetsAt, fromPress), NOW);
                    // The strip's, with the account reading what the daemon read: spent until that reopen, or nothing known.
                    const state: AccountState | undefined = limitResetsAt === undefined ? undefined : { kind: `spent`, reopensAt: limitResetsAt };
                    const pickUp = pickUpWith(`limit`, held, limitResetsAt === undefined ? undefined : limitResetsAt * 1_000);
                    const stripWay = pressWayOf({ pickUp, state, spentUntil: spentUntilOf(state, NOW), accessWall: false, reachable: true, continuing: false, now: NOW });
                    const name = `held=${JSON.stringify(held)} reset=${named(reset)} fromPress=${fromPress}`;
                    if (cardWay === undefined) {
                        wrong.push(`${name}: no press on the card`);
                    } else if (goesAtReopen(cardWay) !== goesAtReopen(stripWay) || cardWay.enabled !== stripWay.enabled) {
                        wrong.push(`${name}: card ${JSON.stringify(cardWay)} vs strip ${JSON.stringify(stripWay)}`);
                    }
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    test(`sends a turn with no reset again now, and books one whose reset is ahead`, () => {
        const atReopen = (card: AgentStanding): boolean | undefined => {
            const way = cardPressWay(card, NOW);
            return way === undefined ? undefined : goesAtReopen(way);
        };
        expect(cardPressWay(cardOf({ limitHeld: true }), NOW)).toEqual({ kind: `continue`, enabled: true });
        expect(atReopen(cardOf({ limitHeld: true, limitResetsAt: s(AHEAD) }))).toBe(true);
        expect(atReopen(cardOf({ limitHeld: true, limitResetsAt: s(PAST) }))).toBe(false);
        expect(atReopen(cardOf({ status: `idle` }))).toBeUndefined();
    });
});
