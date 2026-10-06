import type { PhoneSummary } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// One phone as the Devices board lists it: whether the agent can reach it now, and what it is. A phone is asleep most
// of the time, so asleep is a calm state when the sandbox can wake it, and a warning only when it cannot.

export type PhoneTone = `success` | `neutral` | `warning`;

export interface PhoneRow {
    readonly id: string;
    readonly platform: string;
    readonly state: `connected` | `paused` | `asleep` | `unreachable` | `never paired`;
    readonly tone: PhoneTone;
    readonly detail: string;
}

/** The badge's word for a state; the state itself stays a code the tone and tests read. */
export const phoneStateWord = (state: PhoneRow[`state`]): string =>
    ({
        connected: t(`sandbox.phoneRows.connected`),
        paused: t(`sandbox.phoneRows.paused`),
        asleep: t(`sandbox.phoneRows.asleep`),
        unreachable: t(`sandbox.phoneRows.unreachable`),
        "never paired": t(`sandbox.phoneRows.neverPaired`),
    })[state];

export const phoneRowOf = (phone: PhoneSummary): PhoneRow => {
    const facts = phone.facts;
    // What the hub remembers is empty after a restart, so only the sandbox's own record of a pairing says "never paired";
    // a daemon too old to send it leaves the old reading, from what the phone has said.
    const unpaired = phone.paired === undefined ? phone.lastSeen === undefined && facts === undefined : !phone.paired;
    const state: PhoneRow[`state`] =
        facts?.paused === true
            ? `paused`
            : phone.online
              ? `connected`
              : unpaired
                ? `never paired`
                : phone.wake === `ready`
                  ? `asleep`
                  : `unreachable`;
    const tone: PhoneTone = state === `connected` ? `success` : state === `asleep` ? `neutral` : `warning`;
    const detail = [
        facts === undefined ? `` : `${facts.device} · Android ${facts.android}`,
        facts?.battery === undefined
            ? ``
            : facts.battery.charging
              ? t(`sandbox.phoneRows.batteryCharging`, { level: Math.round(facts.battery.level) })
              : t(`sandbox.phoneRows.battery`, { level: Math.round(facts.battery.level) }),
        state === `unreachable` ? (phone.wake === `register` ? t(`sandbox.phoneRows.finishWaking`) : t(`sandbox.phoneRows.answersWhileOpen`)) : ``,
        state === `never paired` ? t(`sandbox.phoneRows.scanCode`) : ``,
    ]
        .filter((part) => part !== ``)
        .join(` · `);
    return { id: phone.id, platform: phone.platform, state, tone, detail };
};
