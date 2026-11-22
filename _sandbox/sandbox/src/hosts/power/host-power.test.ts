import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import type { HostPower, HostPowerFinding } from "@intentic/sandbox-contract/schemas/host-power";
import { hostConnectionKey } from "@intentic/sandbox-contract/schemas/hosts";
import type { Need, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import {
    type HostPowerCheckDeps,
    POWER_DECLINE_QUIET_MS,
    POWER_LEAD_MS,
    powerBlockers,
    powerCardSuppressed,
    powerDoorOf,
    raiseHostPowerCard,
    windowMeets,
} from "./host-power.js";

// Work booked on a computer that would sleep through it (2026-11-22): rog's power plan slept it five hours after the last
// keypress and a send booked for 07:10 went out at 10:01. What would act before the work is due raises one card, once.

const HOUR = 3_600_000;
const MINUTE = 60_000;
// 2026-11-22 23:00 UTC, which is 00:00 on 2026-11-23 on a computer an hour east of UTC (Warsaw in winter).
const NOW = Date.UTC(2026, 10, 22, 23, 0);
const WARSAW = 60;

const sleepIdle = (afterSeconds: number, power: "ac" | "dc" = "ac"): HostPowerFinding => ({
    id: "sleep-idle",
    power,
    afterSeconds,
    fixable: true,
    text: `Sleeps after ${afterSeconds / 3600} h without input.`,
});
const LID: HostPowerFinding = { id: "lid-close", power: "ac", action: "sleep", fixable: true, text: "Closing the lid sleeps it." };
const STANDBY: HostPowerFinding = { id: "standby-network", fixable: true, text: "The network is cut while the screen is off." };
const BATTERY: HostPowerFinding = { id: "battery-sleep", power: "dc", afterSeconds: 900, fixable: false, text: "On battery it sleeps after 15 min." };
const OS_SLEEP: HostPowerFinding = { id: "os-sleep", fixable: false, command: "sudo systemctl mask sleep.target", text: "The OS may suspend it." };
// Windows Update may restart it from 01:00 to 06:00 local time, outside its active hours.
const UPDATE: HostPowerFinding = { id: "update-restart", window: { fromHour: 1, toHour: 6 }, fixable: false, text: "Windows Update may restart it at night." };

const powerOf = (findings: HostPowerFinding[], utcOffsetMinutes = WARSAW): HostPower => ({ at: NOW, utcOffsetMinutes, findings });
const ids = (findings: readonly HostPowerFinding[]): string[] => findings.map((finding) => finding.id);

describe("powerBlockers", () => {
    it("says nothing about work due within a quarter of an hour, whatever would act", () => {
        const power = powerOf([sleepIdle(60), LID, STANDBY]);
        expect(powerBlockers(power, NOW, NOW + POWER_LEAD_MS - 1)).toEqual([]);
        expect(ids(powerBlockers(power, NOW, NOW + POWER_LEAD_MS))).toEqual(["sleep-idle", "lid-close", "standby-network"]);
    });

    it("counts an idle timer on mains power once it runs out before the work is due, and never one on battery", () => {
        const fiveHours = sleepIdle(5 * 3600);
        expect(powerBlockers(powerOf([fiveHours]), NOW, NOW + 4 * HOUR)).toEqual([]);
        expect(powerBlockers(powerOf([fiveHours]), NOW, NOW + 5 * HOUR)).toEqual([fiveHours]);
        // The night it happened: booked at 00:37 for 07:10, a timer of five hours.
        expect(powerBlockers(powerOf([fiveHours]), NOW, NOW + 6 * HOUR + 33 * MINUTE)).toEqual([fiveHours]);
        expect(powerBlockers(powerOf([sleepIdle(600, "dc")]), NOW, NOW + 8 * HOUR)).toEqual([]);
        const hibernate: HostPowerFinding = { id: "hibernate-idle", power: "ac", afterSeconds: 3 * 3600, fixable: true, text: "Hibernates after 3 h." };
        expect(powerBlockers(powerOf([hibernate]), NOW, NOW + 2 * HOUR)).toEqual([]);
        expect(powerBlockers(powerOf([hibernate]), NOW, NOW + 3 * HOUR)).toEqual([hibernate]);
    });

    it("counts the lid, a standby that cuts the network and an OS suspend at any lead, since they can act at any moment", () => {
        expect(ids(powerBlockers(powerOf([LID, STANDBY, OS_SLEEP]), NOW, NOW + 20 * MINUTE))).toEqual(["lid-close", "standby-network", "os-sleep"]);
    });

    it("never raises for battery sleep by itself: the card shows it as a note", () => {
        expect(powerBlockers(powerOf([BATTERY]), NOW, NOW + 10 * HOUR)).toEqual([]);
        expect(ids(powerBlockers(powerOf([BATTERY, LID]), NOW, NOW + 10 * HOUR))).toEqual(["lid-close"]);
    });

    it("counts an update restart only when the work's span crosses its hours on the computer's own clock, past midnight too", () => {
        // 00:00 to 00:30 local: before the window opens at 01:00.
        expect(powerBlockers(powerOf([UPDATE]), NOW, NOW + 30 * MINUTE)).toEqual([]);
        // 00:00 to 01:00 local: reaches it.
        expect(powerBlockers(powerOf([UPDATE]), NOW, NOW + HOUR)).toEqual([UPDATE]);
        // Read from 07:00 local the same morning to 23:30 local: the window is behind it and the next one not yet come.
        expect(powerBlockers(powerOf([UPDATE]), NOW + 7 * HOUR, NOW + 23 * HOUR + 30 * MINUTE)).toEqual([]);
        // From 07:00 local to 01:30 local the next night: across midnight into the window.
        expect(powerBlockers(powerOf([UPDATE]), NOW + 7 * HOUR, NOW + 25 * HOUR + 30 * MINUTE)).toEqual([UPDATE]);
        // The same UTC hour on a computer at UTC-5 is 18:00 to 19:00 there: read on its own clock, not the daemon's.
        expect(powerBlockers(powerOf([UPDATE], -300), NOW, NOW + HOUR)).toEqual([]);
    });

    it("counts an update restart at any hour when the agent did not say which", () => {
        const anyHour: HostPowerFinding = { id: "update-restart", fixable: false, text: "Windows Update may restart it." };
        expect(powerBlockers(powerOf([anyHour]), NOW, NOW + 20 * MINUTE)).toEqual([anyHour]);
    });

    it("counts an id this build does not know only when the agent's op would change it", () => {
        const changeable: HostPowerFinding = { id: "usb-suspend", fixable: true, text: "USB devices are suspended." };
        const reported: HostPowerFinding = { id: "fan-curve", fixable: false, text: "The fans slow down." };
        expect(powerBlockers(powerOf([changeable, reported]), NOW, NOW + HOUR)).toEqual([changeable]);
    });
});

describe("windowMeets", () => {
    it("finds a window that wraps past midnight, and one on a half-hour offset", () => {
        const night = { fromHour: 22, toHour: 2 };
        // 23:00 local at UTC+1 is 22:00 UTC: inside at once.
        expect(windowMeets(night, WARSAW, NOW - HOUR, NOW - HOUR)).toBe(true);
        // 03:00 to 21:30 local: outside the whole way.
        expect(windowMeets(night, WARSAW, NOW + 3 * HOUR, NOW + 21 * HOUR + 30 * MINUTE)).toBe(false);
        // 03:00 to 22:00 local: reaches its first hour.
        expect(windowMeets(night, WARSAW, NOW + 3 * HOUR, NOW + 22 * HOUR)).toBe(true);
        // India, UTC+05:30: 23:00 UTC is 04:30 local; the 06:00 local hour starts 90 minutes later.
        const dawn = { fromHour: 6, toHour: 7 };
        expect(windowMeets(dawn, 330, NOW, NOW + 89 * MINUTE)).toBe(false);
        expect(windowMeets(dawn, 330, NOW, NOW + 90 * MINUTE)).toBe(true);
    });

    it("looks at a day of hours at most, which visits every hour a window could hold", () => {
        expect(windowMeets({ fromHour: 5, toHour: 6 }, 0, NOW, NOW + 400 * 24 * HOUR)).toBe(true);
        expect(windowMeets({ fromHour: 5, toHour: 5 }, 0, NOW, NOW)).toBe(true);
    });
});

const needOf = (id: string, subject: NeedSubject, status: Need["status"], updatedAt: number, conversationId = "conv-a"): Need => ({
    id,
    conversationId,
    subject,
    title: "rog would sleep through work booked here",
    status,
    createdAt: updatedAt,
    updatedAt,
});
const card = (findings: HostPowerFinding[], device = "rog"): NeedSubject => ({ kind: "host-power", device, findings, dueAt: NOW + 8 * HOUR });

describe("powerCardSuppressed", () => {
    it("raises nothing while a card for that computer is open in any conversation", () => {
        const open = needOf("need-1", card([LID]), "open", NOW - HOUR, "conv-other");
        expect(powerCardSuppressed([open], "rog", [LID], NOW)).toBe("need-1 is already open for it, in conversation conv-other");
        // Another computer's card is not this one's.
        expect(powerCardSuppressed([needOf("need-2", card([LID], "omen"), "open", NOW)], "rog", [LID], NOW)).toBeUndefined();
    });

    it("keeps a declined card down for a week while it named every blocker, and raises again for something new", () => {
        const declined = needOf("need-1", card([sleepIdle(5 * 3600), LID, BATTERY]), "declined", NOW - 6 * 24 * HOUR);
        expect(powerCardSuppressed([declined], "rog", [LID], NOW)).toBe("a person declined need-1 for the same findings within the week");
        expect(powerCardSuppressed([declined], "rog", [LID, STANDBY], NOW)).toBeUndefined();
        expect(powerCardSuppressed([declined], "rog", [LID], NOW - 6 * 24 * HOUR + POWER_DECLINE_QUIET_MS)).toBeUndefined();
    });

    it("raises again after a card was met or withdrawn: the settings came back", () => {
        const met = needOf("need-1", card([LID]), "met", NOW - HOUR);
        const cancelled = needOf("need-2", card([LID]), "cancelled", NOW - HOUR);
        expect(powerCardSuppressed([met, cancelled], "rog", [LID], NOW)).toBeUndefined();
    });
});

describe("powerDoorOf", () => {
    const native: Device = { key: "rog", label: "rog", hostId: "rog", card: "rog", online: true };
    const distro: Device = { key: "rog-arch", label: "rog (archlinux)", hostId: hostConnectionKey("rog", "wsl:archlinux"), card: "rog", online: true };

    it("asks the native side of the machine whose WSL distro runs this sandbox, where its power settings are said", () => {
        expect(powerDoorOf([distro, native], distro.hostId ?? "")).toEqual({ device: "rog", name: "rog" });
    });

    it("asks a Linux computer's own door, and nothing when only a distro of a PC is connected, which says nothing of power", () => {
        const lone: Device = { key: "z440", label: "z440", hostId: "z440", card: "z440", online: true };
        expect(powerDoorOf([lone], "z440")).toEqual({ device: "z440", name: "z440" });
        expect(powerDoorOf([distro], distro.hostId ?? "")).toBeUndefined();
    });
});

interface Fakes {
    readonly deps: HostPowerCheckDeps;
    readonly observed: { conversationId: string; subject: NeedSubject; title: string }[];
    readonly refreshed: string[];
    readonly info: string[];
    readonly state: { power: HostPower | undefined; self: boolean; stored: Need[]; refreshFails: boolean };
}

// rog the night it happened: asleep five hours after the last keypress, and on battery sooner.
const ROG = powerOf([sleepIdle(5 * 3600), BATTERY]);

const fakes = (): Fakes => {
    const observed: Fakes["observed"] = [];
    const refreshed: string[] = [];
    const info: string[] = [];
    const state: Fakes["state"] = { power: ROG, self: true, stored: [], refreshFails: false };
    const deps: HostPowerCheckDeps = {
        now: () => NOW,
        selfHost: async () => (state.self ? { device: "rog", name: "rog" } : undefined),
        refresh: async (device) => {
            refreshed.push(device);
            if (state.refreshFails) {
                throw new Error("rog did not answer");
            }
        },
        power: () => state.power,
        needs: {
            list: async () => state.stored,
            observe: async (conversationId, subject, title) => {
                observed.push({ conversationId, subject, title });
                return needOf("need-new", subject, "open", NOW, conversationId);
            },
        },
        logger: { info: (_fields: object, message?: string) => void info.push(message ?? "") },
    };
    return { deps, observed, refreshed, info, state };
};

describe("raiseHostPowerCard", () => {
    it("raises one card in the booking conversation, holding every finding and when the work is due, with no clock time in its title", async () => {
        const { deps, observed, refreshed, info } = fakes();
        const need = await raiseHostPowerCard(deps, "conv-a", NOW + 8 * HOUR);
        expect(need?.id).toBe("need-new");
        expect(refreshed).toEqual(["rog"]);
        expect(observed).toEqual([
            {
                conversationId: "conv-a",
                subject: { kind: "host-power", device: "rog", findings: ROG.findings, dueAt: NOW + 8 * HOUR },
                title: "rog would sleep through work booked here",
            },
        ]);
        expect(info).toEqual(["host power: booked work would be slept through; card raised"]);
    });

    it("raises nothing on a runner or in the cloud, for an agent older than the field, or when nothing acts before the work", async () => {
        const away = fakes();
        away.state.self = false;
        expect(await raiseHostPowerCard(away.deps, "conv-a", NOW + 8 * HOUR)).toBeUndefined();
        expect(away.refreshed).toEqual([]);

        const older = fakes();
        older.state.power = undefined;
        expect(await raiseHostPowerCard(older.deps, "conv-a", NOW + 8 * HOUR)).toBeUndefined();

        const soon = fakes();
        expect(await raiseHostPowerCard(soon.deps, "conv-a", NOW + 2 * HOUR)).toBeUndefined();
        expect([...away.observed, ...older.observed, ...soon.observed]).toEqual([]);
    });

    it("reads what the computer said last when it does not answer in time", async () => {
        const { deps, observed, state } = fakes();
        state.refreshFails = true;
        await raiseHostPowerCard(deps, "conv-a", NOW + 8 * HOUR);
        expect(observed).toHaveLength(1);
    });

    it("says why in the log, and raises nothing, when a card is already up elsewhere", async () => {
        const { deps, observed, info, state } = fakes();
        state.stored = [needOf("need-1", card([LID]), "open", NOW - HOUR, "conv-b")];
        expect(await raiseHostPowerCard(deps, "conv-a", NOW + 8 * HOUR)).toBeUndefined();
        expect(observed).toEqual([]);
        expect(info).toEqual(["host power: booked work would be slept through; no new card"]);
    });
});
