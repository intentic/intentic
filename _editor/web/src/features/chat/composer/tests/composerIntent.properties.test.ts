// What the next Send press means, over every snapshot the composer can be in: the whole product of ComposerSituation's
// inputs, each rule below asserted for each one. composerIntent.test.ts pins the precedence case by case; this pins that
// the readings never contradict one another anywhere, since a placeholder, a refusal line, a greyed Send and a bare
// Enter that disagree are the bugs this surface has had. Then the same snapshot read with the strip's press
// (pressWay.ts), built as the pane builds it (composerSend.ts), so the composer and the strip above it cannot leave a
// stopped turn with no way on and no word on why.
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { HeldEnding } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Tip, TooltipValue } from "@intentic/ui";
import { type SendBlock, sendBlockOf } from "../../../../models/providers/sendAvailability";
import { spentUntilOf } from "../../../../models/conversations/accounts/runServing";
import { type HeldTurn, LIMIT_COOLDOWN_MS, type PickUp, pickUpReady } from "../../../../models/conversations/endings/pickUp";
import { pressGoes, pressWayOf } from "../../../../models/conversations/endings/pressWay";
import {
    type ComposerSituation,
    type ComposerWords,
    continueOffered,
    continueVisible,
    placeholderFor,
    type PickUpSituation,
    reopenPressOf,
    sendable,
    sendAnyway,
    sendHintFor,
    type SendIntent,
    sendIntentOf,
    sendRefusal,
    sendRefusalTitle,
} from "../composerIntent";

const NOW = 1_800_000_000_000;
const AHEAD = NOW + 2 * 3_600_000;
const PAST = NOW - 60_000;

// The first few that break a rule: enough to read it by, since one broken rule breaks it for millions of snapshots.
const LIMIT = 12;

/** Every combination of `axes`, the last varying fastest, visited one at a time by its index: none is ever held. */
const eachOf = (axes: readonly number[], visit: (digits: readonly number[]) => void): number => {
    const total = axes.reduce((product, size) => product * size, 1);
    const digits = axes.map(() => 0);
    for (let index = 0; index < total; index += 1) {
        let rest = index;
        for (let axis = axes.length - 1; axis >= 0; axis -= 1) {
            const size = axes[axis] ?? 1;
            digits[axis] = rest % size;
            rest = Math.floor(rest / size);
        }
        visit(digits);
    }
    return total;
};

const PICK_UPS: readonly (PickUpSituation | undefined)[] = [
    undefined,
    ...[true, false].flatMap((ready) => ([undefined, `book`, `arm`, `armed`] as const).map((atReopen) => ({ ready, atReopen }))),
];
const BLOCKS: readonly (SendBlock | undefined)[] = [undefined, `spent`, `editSpent`, `reconnect`, `admin`, `verify`, `wait`];
const INTENTS: readonly SendIntent[] = [`place`, `edit`, `plan`, `answer`, `later`, `scheduled`, `idle`, `parked`, `steer`, `queue`];
// The card on screen waiting for an answer (axis 6): none, a plan, or a question or page. A turn parks on one at a time.
const CARDS = 3;
// The fourteen yes-or-no inputs (the card three-way), then the pick-up, the queue, the reopen and the account's block.
const AXES = [...Array.from({ length: 14 }, (_, axis) => (axis === 6 ? CARDS : 2)), PICK_UPS.length, 2, 2, BLOCKS.length];

// The snapshot one combination of AXES names.
const situationOf = (digits: readonly number[]): ComposerSituation => {
    const on = (axis: number): boolean => digits[axis] === 1;
    return {
        staged: on(0),
        attached: on(1),
        uploading: on(2),
        uploadFailed: on(3),
        voiceAgent: on(4),
        editing: on(5),
        pendingPlan: on(6),
        pendingAsk: digits[6] === 2,
        streaming: on(7),
        awaitingDecision: on(8),
        waitingOnYou: on(9),
        steerable: on(10),
        queueScheduled: on(11),
        connected: on(12),
        later: on(13),
        pickUp: PICK_UPS[digits[14] ?? 0],
        queued: digits[15] ?? 0,
        spentUntil: on(16) ? AHEAD : undefined,
        accountBlock: BLOCKS[digits[17] ?? 0],
    };
};

// A snapshot as one line: the inputs that are on, and the rest as they stand.
const named = (situation: ComposerSituation): string => {
    const on = Object.entries(situation)
        .filter(([, value]) => value === true)
        .map(([key]) => key);
    return JSON.stringify({
        on,
        pickUp: situation.pickUp,
        queued: situation.queued,
        spentUntil: situation.spentUntil,
        accountBlock: situation.accountBlock,
    });
};

// What the bare press on an empty box does (composerSend.ts barePressOf, with no room just made): continue now, at the
// reopen, or nothing.
const bareOf = (situation: ComposerSituation, refusal: string | undefined): `now` | `reopen` | undefined => {
    if (refusal !== undefined) {
        return undefined;
    }
    if (continueOffered(situation)) {
        return `now`;
    }
    return reopenPressOf(situation) === undefined ? undefined : `reopen`;
};

// An empty press that sends what waited: the messages written while the agent was busy, none of them booked, nothing
// running, no plan pending, and no account reading in the way of a fresh turn (composerIntent.ts queueFlushable and
// accountCautionOf, whose rule this restates).
const flushes = (situation: ComposerSituation): boolean => {
    const freshTurn =
        !situation.voiceAgent &&
        !situation.editing &&
        !situation.streaming &&
        !situation.pendingPlan &&
        situation.pendingAsk !== true &&
        situation.later !== true;
    const cautioned = freshTurn && situation.accountBlock !== undefined;
    return situation.queued > 0 && !situation.streaming && !situation.pendingPlan && situation.queueScheduled !== true && !cautioned;
};

// Every rule one snapshot breaks, by name. Named only once broken: millions of snapshots pass through here.
const brokenRules = (situation: ComposerSituation): readonly string[] => {
    const intent = sendIntentOf(situation);
    const refusal = sendRefusal(situation);
    const title = sendRefusalTitle(situation);
    const sends = sendable(situation, intent, refusal);
    const visible = continueVisible(situation);
    const offered = continueOffered(situation);
    const reopen = reopenPressOf(situation);
    const anyway = sendAnyway(situation);
    const walled = situation.accountBlock !== undefined || situation.spentUntil !== undefined;
    const broken: string[] = [];
    const rule = (name: string, breaks: boolean): void => {
        if (breaks) {
            broken.push(name);
        }
    };
    // A refusal is said in both its forms or in neither, and never as an empty line.
    rule(`a refusal line without its title, or the reverse`, (refusal === undefined) !== (title === undefined) || refusal === `` || title === ``);
    rule(`Send enabled with a refusal`, sends && refusal !== undefined);
    rule(`a bare Continue offered with no strip`, offered && !visible);
    rule(
        `a press at the reopen with no reopen ahead, beside a Continue now, or with no strip`,
        reopen !== undefined && (situation.spentUntil === undefined || offered || !visible),
    );
    // A bare press that continues now never meets the wall it would be refused at.
    rule(`a bare Continue into a wall`, offered && (walled || situation.pickUp?.ready !== true));
    // Place, edit, an answer and a booking for later need words: an empty press would place nothing, rewind, settle a
    // card with nothing said, or book nothing.
    rule(
        `an empty place, edit, answer or booking sends`,
        (intent === `place` || intent === `edit` || intent === `answer` || intent === `later`) && !situation.staged && sends,
    );
    // A question or page waiting takes the words as its answer, ahead of any queue: never held behind the card it answers.
    rule(`words held behind the card they answer`, situation.pendingAsk === true && (intent === `parked` || intent === `queue` || intent === `steer`));
    // The agent's voice has no live turn to speak into.
    rule(
        `the agent's voice goes into a running turn`,
        situation.voiceAgent && situation.streaming && (sends || (situation.staged && refusal === undefined)),
    );
    rule(`the agent's voice and the place intent apart`, (intent === `place`) !== situation.voiceAgent);
    rule(`a scheduled send with no reopen`, intent === `scheduled` && situation.spentUntil === undefined);
    // A scheduled send's empty press goes only as the continuation its time-labelled button names.
    rule(`an empty scheduled press with nothing to book`, intent === `scheduled` && !situation.staged && sends && reopen === undefined);
    // "Send anyway" is only ever on a Send that goes, over the account reading in the way, for words in the box.
    rule(
        `Send anyway on a press that does not go`,
        anyway !== undefined && (!sends || !situation.staged || refusal !== undefined || anyway !== situation.accountBlock),
    );
    // An edit rewinds before the provider answers: a spent or blocked account refuses it outright, never anyway.
    rule(`an edit let through onto a wall`, situation.editing && !situation.voiceAgent && walled && refusal === undefined);
    // Nothing to send with: no strip, and nothing an empty press could do.
    rule(`a press offered with no account to send with`, !situation.connected && (visible || offered || reopen !== undefined));
    // An empty press that goes does something: continue now, book, or send what waits.
    rule(`an empty press enabled with nothing to do`, sends && !situation.staged && !offered && reopen === undefined && !flushes(situation));
    // The bare press and the box agree: an empty Enter that continues or books is a press Send allows.
    rule(`Enter continues while Send is greyed`, !situation.staged && bareOf(situation, refusal) !== undefined && !sends);
    return broken;
};

// The words a hover says first: a card's headline, or a label's words (a primitive, never an Object).
const isTip = (hint: TooltipValue): hint is Tip => hint instanceof Object;
const headline = (hint: TooltipValue): string => {
    if (isTip(hint)) {
        return hint.title;
    }
    return hint === false || hint === null || hint === undefined ? `` : hint;
};

// Every set of words a pane can hand the ladder.
const WORDS: readonly ComposerWords[] = [undefined, true].flatMap((plain) =>
    [false, true].flatMap((onTrial) =>
        [0, 1, 3].flatMap((editDropped) =>
            [false, true].map((filled) => {
                let words: ComposerWords = { provider: `Claude`, onTrial, editDropped };
                if (plain !== undefined) {
                    words = { ...words, plain };
                }
                return filled ? { ...words, reopens: `02:00`, followsWaiting: true, later: `at 09:00`, heldGoesToo: true } : words;
            }),
        ),
    ),
);

describe(`every snapshot of the composer`, () => {
    test(`never contradicts itself`, () => {
        const wrong: string[] = [];
        const seen = new Set<SendIntent>();
        const total = eachOf(AXES, (digits) => {
            const situation = situationOf(digits);
            seen.add(sendIntentOf(situation));
            const broken = brokenRules(situation);
            if (broken.length > 0 && wrong.length < LIMIT) {
                wrong.push(`${broken.join(`; `)}: ${named(situation)}`);
            }
        });
        expect(wrong).toEqual([]);
        expect(total).toBe(2 ** 13 * CARDS * PICK_UPS.length * 2 * 2 * BLOCKS.length);
        expect([...seen].sort()).toEqual([...INTENTS].sort());
        // Six million snapshots: seconds alone, longer on a machine busy with other suites.
    }, 300_000);

    // Every intent says what a press there does, in every set of words a pane can hand it.
    test(`has a placeholder and a Send hint for every intent, in every set of words`, () => {
        const wrong = INTENTS.flatMap((intent) =>
            WORDS.filter((words) => placeholderFor(intent, words).trim() === `` || headline(sendHintFor(intent, words)).trim() === ``).map(
                (words) => `${intent} ${JSON.stringify(words)}`,
            ),
        );
        expect(wrong).toEqual([]);
        expect(WORDS.length).toBe(24);
    });
});

/* THE COMPOSER BESIDE THE STRIP. The snapshot as the pane builds it from a real pick-up and the reading of the account
   the press would run on (composerSend.ts: pickUpReady, spentUntilOf, sendBlockOf), read with the strip's press
   (pressWay.ts) and the pane's own gate on it (composerSend's `pressable`: the press goes, and the box refuses nothing).
   Wherever the strip shows, a reader has a way on or is told why not: Enter continues or books, the strip's own press is
   enabled, or the strip rests, the sandbox does not answer, a press is going, or the composer's refusal line says why. */

const REASONS: readonly HeldEnding[] = [`limit`, `stopped`, `outage`, `flagged`];
const HELDS: readonly (HeldTurn | undefined)[] = [undefined, { ran: true }, { ran: false }, { ran: true, pressOnly: true }];
const STATES: readonly (readonly [string, AccountState | undefined])[] = [
    [`none read`, undefined],
    [`ready`, { kind: `ready`, room: 40 }],
    [`unknown`, { kind: `unknown` }],
    [`spent, reopen ahead`, { kind: `spent`, reopensAt: Math.round(AHEAD / 1_000) }],
    [`spent, reopen past`, { kind: `spent`, reopensAt: Math.round(PAST / 1_000) }],
    [`spent, no reopen`, { kind: `spent` }],
    [`blocked, reconnect`, { kind: `blocked`, fix: `reconnect`, reason: `signed out` }],
    [`blocked, admin`, { kind: `blocked`, fix: `admin`, reason: `seat removed` }],
    [`blocked, verify`, { kind: `blocked`, fix: `verify`, reason: `verify`, url: `https://example.test` }],
    [`blocked, wait`, { kind: `blocked`, fix: `wait`, reason: `suspended` }],
    [`blocked, wait until ahead`, { kind: `blocked`, fix: `wait`, reason: `suspended`, until: Math.round(AHEAD / 1_000) }],
];
const RESETS: readonly (number | undefined)[] = [undefined, AHEAD, PAST];
const COOLS: readonly (number | undefined)[] = [undefined, NOW + LIMIT_COOLDOWN_MS];

// A pick-up with whichever of its optional facts are given.
const pickUpWith = (reason: HeldEnding, held: HeldTurn | undefined, readyAt: number | undefined, coolUntil: number | undefined): PickUp => {
    let pickUp: PickUp = { reason };
    if (held !== undefined) {
        pickUp = { ...pickUp, held };
    }
    if (readyAt !== undefined) {
        pickUp = { ...pickUp, readyAt };
    }
    return coolUntil === undefined ? pickUp : { ...pickUp, coolUntil };
};

// How the turn goes on at the reopen (composerSend.ts atReopenOf), as its second of two readings: a held limit turn by
// its answer, unset or set; any other by a continuation booked where the sandbox books one, or by nothing; a flagged turn
// by nothing either way.
const atReopenOf = (pickUp: PickUp, second: boolean): PickUpSituation[`atReopen`] => {
    if (pickUp.reason === `flagged`) {
        return undefined;
    }
    if (pickUp.reason === `limit` && pickUp.held !== undefined) {
        return second ? `armed` : `arm`;
    }
    return second ? undefined : `book`;
};

// The strip, read beside the composer for one shown pick-up: every way it leaves a reader stuck, by name.
const strandedWays = (pickUp: PickUp, state: AccountState | undefined, digits: readonly number[]): readonly string[] => {
    const [second, editing, streaming, unreachable, continuing] = digits.map((digit) => digit === 1);
    const reachable = unreachable !== true;
    const pressing = continuing === true;
    const atReopen = atReopenOf(pickUp, second === true);
    const spentUntil = spentUntilOf(state, NOW);
    const situation: ComposerSituation = {
        staged: false,
        attached: false,
        uploading: false,
        uploadFailed: false,
        voiceAgent: false,
        editing: editing === true,
        pendingPlan: false,
        streaming: streaming === true,
        awaitingDecision: false,
        waitingOnYou: false,
        steerable: false,
        pickUp: { ready: pickUpReady(pickUp, NOW), atReopen },
        queued: 0,
        connected: true,
        spentUntil,
        accountBlock: sendBlockOf(state, NOW, editing === true),
    };
    if (!continueVisible(situation)) {
        return [`a strip hidden from an empty, connected box`];
    }
    const refusal = sendRefusal(situation);
    const way = pressWayOf({ pickUp, state, spentUntil, accessWall: false, reachable, continuing: pressing, now: NOW });
    const goes = pressGoes(pickUp, reachable, pressing, NOW);
    // composerSend's `pressable`: the strip's `ready`, and the gate on the composer's own Continue.
    const pressable = goes && refusal === undefined;
    const stripGoes = reachable && pressable && !pressing;
    const bare = bareOf(situation, refusal);
    const enterGoes = (bare === `now` && pressable) || (bare === `reopen` && reachable);
    const told = way.rest !== undefined || refusal !== undefined;
    // Enter's own press at the reopen: on an empty box over no live turn and no armed edit (composerIntent.ts bareFree).
    const atReopenPress = (atReopen === `book` || atReopen === `arm`) && streaming !== true && editing !== true;
    const rules: readonly (readonly [string, boolean])[] = [
        [`no way on and no word on why`, !enterGoes && !stripGoes && !told],
        // The strip's press and the pane's gate on it are one reading.
        [`the strip and the composer read the press apart`, way.enabled !== goes],
        // Enter never continues now where the strip's press is held back, nor quietly tries a wall: trying past a reading
        // is the strip's explicit press alone.
        [`Enter continues where the strip rests`, bare === `now` && pressable && !way.enabled],
        [`Enter tries a wall`, bare === `now` && (way.kind === `try` || way.kind === `tryThenAt`)],
        // A rest after a refusal holds back both, until it is over.
        [`a press through the rest`, way.rest === `cooling` && (bare === `now` || stripGoes)],
        // A reopen ahead is the strip's solid press, and Enter's wherever it books or arms one.
        [`Enter's reopen press and the strip's apart`, (bare === `reopen`) !== (way.kind === `tryThenAt` && atReopenPress && refusal === undefined)],
    ];
    return rules.filter(([, broken]) => broken).map(([rule]) => rule);
};

describe(`the composer beside the strip`, () => {
    test(`leaves no shown strip without a way on or a word on why`, () => {
        const wrong: string[] = [];
        // The ending, its hold, its own reset, its rest, the account's reading, then the second reading of the reopen
        // press, editing, streaming, unreachable and a press under way.
        const axes = [REASONS.length, HELDS.length, RESETS.length, COOLS.length, STATES.length, 2, 2, 2, 2, 2];
        const total = eachOf(axes, (digits) => {
            const [reason, held, reset, cool, stateAt] = digits;
            const pickUp = pickUpWith(REASONS[reason ?? 0] ?? `stopped`, HELDS[held ?? 0], RESETS[reset ?? 0], COOLS[cool ?? 0]);
            const [stateName, state] = STATES[stateAt ?? 0] ?? [`none read`, undefined];
            const stranded = strandedWays(pickUp, state, digits.slice(5));
            if (stranded.length > 0 && wrong.length < LIMIT) {
                wrong.push(`${stranded.join(`; `)}: ${JSON.stringify(pickUp)} / ${stateName} / ${digits.slice(5).join(``)}`);
            }
        });
        expect(wrong).toEqual([]);
        expect(total).toBe(REASONS.length * HELDS.length * RESETS.length * COOLS.length * STATES.length * 2 ** 5);
    });
});
