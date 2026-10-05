import type { PhoneSummary } from "@intentic/sandbox-contract";
import { phoneRowOf } from "./phoneRows";

const facts = (paused = false): NonNullable<PhoneSummary[`facts`]> => ({
    device: `Google Pixel 8`,
    android: `16`,
    sdk: 36,
    build: `direct`,
    paused,
    access: { accessibility: true, notifications: false, screenCapture: `accessibility` },
    folders: [],
    apps: [],
    battery: { level: 81.4, charging: true },
});
const phone = (overrides: Partial<PhoneSummary>): PhoneSummary => ({ id: `pixel`, platform: `android`, online: false, wake: `ready`, ...overrides });

test(`a connected phone is green and says what it is and how charged`, () => {
    expect(phoneRowOf(phone({ online: true, lastSeen: 1, facts: facts() }))).toEqual({
        id: `pixel`,
        platform: `android`,
        state: `connected`,
        tone: `success`,
        detail: `Google Pixel 8 · Android 16 · battery 81% charging`,
    });
});

test(`asleep is calm when the sandbox can wake it, and a warning with the way out when it cannot`, () => {
    expect(phoneRowOf(phone({ lastSeen: 1, facts: facts() }))).toMatchObject({ state: `asleep`, tone: `neutral` });
    expect(phoneRowOf(phone({ lastSeen: 1, facts: facts(), wake: `register` }))).toMatchObject({
        state: `unreachable`,
        tone: `warning`,
        detail: `Google Pixel 8 · Android 16 · battery 81% charging · open Capabilities to finish setting up waking`,
    });
    expect(phoneRowOf(phone({ lastSeen: 1, facts: facts(), wake: `none` })).detail).toContain(`answers only while its app is open`);
});

test(`the person's pause wins over everything, and a phone never seen says how to pair it`, () => {
    expect(phoneRowOf(phone({ online: true, lastSeen: 1, facts: facts(true) }))).toMatchObject({ state: `paused`, tone: `warning` });
    expect(phoneRowOf(phone({ wake: `none` }))).toMatchObject({ state: `never paired`, detail: `scan its code from Capabilities` });
});
