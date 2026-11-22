import { type HostPower, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { aboutFields, findingItem, outcomeItems, statusLater } from "./power-command.js";
import type { WindowsPowerReading } from "./windows-reading.js";

/* WHAT `power status` AND `power stay-on` SHOW: each finding a row, what stay-on would change a warning, and after a
   stay-on each finding as what became of it. */

const SLEEP = { id: POWER_FINDING.sleepIdle, power: "ac" as const, afterSeconds: 18_000, plans: ["Turbo"], fixable: true, text: "Sleeps after 5 hours without input on mains power (plan: Turbo)." };
const LID = { id: POWER_FINDING.lidClose, power: "ac" as const, action: "sleep", plans: ["Turbo"], fixable: true, text: "Closing the lid on mains power puts it to sleep (plan: Turbo)." };
const RESTART = { id: POWER_FINDING.updateRestart, window: { fromHour: 2, toHour: 8 }, fixable: false, text: "Windows Update may restart it between 02:00 and 08:00 local time." };
const OS_SLEEP = { id: POWER_FINDING.osSleep, power: "ac" as const, fixable: false, command: "sudo pmset -c sleep 0", text: "Sleeps after 10 minutes without input on mains power." };

const power = (findings: HostPower["findings"]): HostPower => ({ at: 1, utcOffsetMinutes: 60, findings });

test("a finding stay-on changes is a warning, one it leaves is dim, each under its id with the agent's sentence", () => {
    expect(findingItem(SLEEP)).toEqual({ tone: "warn", name: "sleep-idle", meta: SLEEP.text });
    expect(findingItem(RESTART)).toEqual({ tone: "skip", name: "update-restart", meta: RESTART.text });
});

test("the status offers stay-on where it would change something, the root command where it cannot, and restore after a stay-on", () => {
    expect(statusLater(power([SLEEP, RESTART]), false)).toEqual([["keep it on while plugged in", "intentic-machine power stay-on"]]);
    expect(statusLater(power([OS_SLEEP]), false)).toEqual([["stop it (needs root)", "sudo pmset -c sleep 0"]]);
    expect(statusLater(power([RESTART]), true)).toEqual([["put back what stay-on changed", "intentic-machine power restore"]]);
});

test("after a stay-on each finding says it changed, is still there, or was left as it is", () => {
    expect(outcomeItems(power([SLEEP, LID, RESTART]), power([LID, RESTART]))).toEqual([
        { tone: "ok", name: "sleep-idle", meta: "never sleeps by itself on mains power now" },
        { tone: "fail", name: "lid-close", meta: `still: ${LID.text}` },
        { tone: "skip", name: "update-restart", meta: RESTART.text },
    ]);
});

test("the status says what its reading rests on: the plans with the active one marked, the battery, Modern Standby, the active hours", () => {
    const reading: WindowsPowerReading = {
        at: 1,
        plans: [
            { guid: "a", name: "Balanced", active: false, settings: { standbyIdle: null, hibernateIdle: null, lidAction: null, standbyConnectivity: null } },
            { guid: "b", name: "Turbo", active: true, settings: { standbyIdle: null, hibernateIdle: null, lidAction: null, standbyConnectivity: null } },
        ],
        modernStandby: undefined,
        battery: true,
        lid: true,
        activeHours: { start: 8, end: 2 },
        utcOffsetMinutes: 60,
    };
    expect(aboutFields({ kind: "windows", reading, power: power([]) })).toEqual([
        ["power plans", "Balanced, Turbo (active)"],
        ["battery", "yes"],
        ["Modern Standby", "could not be read"],
        ["active hours", "08:00 to 02:00"],
    ]);
});
