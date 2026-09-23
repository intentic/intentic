import { MAX_WAKES, type MachinePower, type PowerEvent, stepPower, UNREAD, WAKE_THROTTLE_MS, wakeDue, wakeRefusalOf } from "./machinePower";

// Pins the down clock and the wake reflex's budget as values: a down reading starts the clock and later ones keep it,
// an up reading ends the episode with its allowance and refusal, a failed read establishes nothing, and a start is due
// only with none in flight, the allowance unspent and the throttle past.

const at = 1_000_000;
const down: MachinePower = { ...UNREAD, reading: `stopped`, downSince: at - 5_000 };

describe(`the machine's power`, () => {
    it.each<[string, MachinePower, PowerEvent, MachinePower]>([
        [
            `starts the down clock on the first down reading`,
            UNREAD,
            { kind: `read`, reading: `stopped`, at },
            { ...UNREAD, reading: `stopped`, downSince: at },
        ],
        [`keeps the clock across down readings`, down, { kind: `read`, reading: `failed`, at }, { ...down, reading: `failed` }],
        [`counts a vanished machine as down`, UNREAD, { kind: `read`, reading: `gone`, at }, { ...UNREAD, reading: `gone`, downSince: at }],
        [
            `ends the episode on an up reading, with its allowance and its refusal`,
            { ...down, wakes: 2, lastWakeAt: at - 40_000, refusal: `hours` },
            { kind: `read`, reading: `started`, at },
            { ...UNREAD, reading: `started`, wakes: 0, lastWakeAt: at - 40_000 },
        ],
        [`takes nothing from a failed read`, down, { kind: `read`, reading: undefined, at }, down],
        [`spends a start`, down, { kind: `wake`, at }, { ...down, waking: true, wakes: 1, lastWakeAt: at }],
        [
            `narrates a taken start as a boot`,
            { ...down, waking: true, wakes: 1, lastWakeAt: at },
            { kind: `woke`, at },
            { ...UNREAD, reading: `starting`, waking: true, wakes: 1, lastWakeAt: at },
        ],
        [`keeps the platform's refusal`, down, { kind: `refused`, refusal: `suspended` }, { ...down, refusal: `suspended` }],
        [`ends the start in flight`, { ...down, waking: true }, { kind: `settled` }, down],
        [
            `forgets the old machine's readings, but not the starts spent on it`,
            { ...down, wakes: 2, refusal: `hours` },
            { kind: `forgot` },
            { ...UNREAD, wakes: 2, refusal: `hours` },
        ],
        [
            `gives a restarted machine a new episode, keeping only when the last start left`,
            { ...down, wakes: 3, lastWakeAt: at, refusal: `hours` },
            { kind: `restarted` },
            { ...UNREAD, lastWakeAt: at },
        ],
    ])(`%s`, (_, power, event, next) => {
        expect(stepPower(power, event)).toEqual(next);
    });

    it(`is due a start only with none in flight, the allowance unspent and the throttle past`, () => {
        const ready: MachinePower = { ...down, wakes: MAX_WAKES - 1, lastWakeAt: at - WAKE_THROTTLE_MS };
        expect(wakeDue(ready, at)).toBe(true);
        expect(wakeDue({ ...ready, waking: true }, at)).toBe(false);
        expect(wakeDue({ ...ready, wakes: MAX_WAKES }, at)).toBe(false);
        expect(wakeDue({ ...ready, lastWakeAt: at - WAKE_THROTTLE_MS + 1 }, at)).toBe(false);
    });

    it(`bounds one episode at three starts, thirty seconds apart`, () => {
        expect([MAX_WAKES, WAKE_THROTTLE_MS]).toEqual([3, 30_000]);
    });
});

describe(`a refused start`, () => {
    it.each<[string, unknown, ReturnType<typeof wakeRefusalOf>]>([
        [`spent hours, by code`, { code: `PAYMENT_REQUIRED` }, `hours`],
        [`spent hours, by status`, { status: 402 }, `hours`],
        [`a switched-off account, by code`, { code: `FORBIDDEN` }, `suspended`],
        [`a switched-off account, by status`, { status: 403 }, `suspended`],
        [`a bad minute`, { code: `INTERNAL_SERVER_ERROR`, status: 500 }, undefined],
        [`a thrown string`, `offline`, undefined],
        [`nothing at all`, undefined, undefined],
    ])(`reads %s`, (_, err, refusal) => {
        expect(wakeRefusalOf(err)).toBe(refusal);
    });
});
