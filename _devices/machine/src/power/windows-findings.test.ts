import { fixablePowerFindings, HostPowerSchema, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { windowsFindings } from "./windows-findings.js";
import type { IndexPair, PlanReading, PowerSettingKey, WindowsPowerReading } from "./windows-reading.js";

/* WHAT A WINDOWS READING SAYS, as the findings the device's facts carry: pure over hand-made readings shaped like the
   computers it meets. rog's own reading is windows-reading.test.ts's. */

const AT = Date.parse("2026-11-22T15:00:00.000Z");

const plan = (name: string, settings: Partial<Record<PowerSettingKey, IndexPair>>, active = false): PlanReading => ({
    guid: `${name.toLowerCase().padEnd(8, "0").slice(0, 8)}-0000-0000-0000-000000000000`,
    name,
    active,
    settings: {
        standbyIdle: settings.standbyIdle ?? null,
        hibernateIdle: settings.hibernateIdle ?? null,
        lidAction: settings.lidAction ?? null,
        standbyConnectivity: settings.standbyConnectivity ?? null,
    },
});

const reading = (plans: readonly PlanReading[], rest: Partial<WindowsPowerReading> = {}): WindowsPowerReading => ({
    at: AT,
    plans,
    modernStandby: true,
    battery: true,
    lid: true,
    activeHours: undefined,
    utcOffsetMinutes: 60,
    ...rest,
});

// A Windows 11 laptop at its defaults: Balanced alone, sleep after 30 minutes plugged in and 15 on battery, hibernate
// after 3 hours, the lid sleeps, the network managed by Windows in standby, active hours 8 to 17.
const LAPTOP = reading(
    [
        plan(
            "Balanced",
            {
                standbyIdle: { ac: 1800, dc: 900 },
                hibernateIdle: { ac: 10_800, dc: 10_800 },
                lidAction: { ac: 1, dc: 1 },
                standbyConnectivity: { ac: 2, dc: 2 },
            },
            true,
        ),
    ],
    { activeHours: { start: 8, end: 17 } },
);

test("a laptop at Windows' defaults sleeps, hibernates and sleeps on the lid plugged in, sleeps on battery, and restarts at night", () => {
    const power = windowsFindings(LAPTOP);
    expect(HostPowerSchema.parse(power)).toEqual(power);
    expect(power.findings).toEqual([
        {
            id: POWER_FINDING.sleepIdle,
            power: "ac",
            afterSeconds: 1800,
            plans: ["Balanced"],
            fixable: true,
            text: "Sleeps after 30 minutes without input on mains power (plan: Balanced).",
        },
        {
            id: POWER_FINDING.hibernateIdle,
            power: "ac",
            afterSeconds: 10_800,
            plans: ["Balanced"],
            fixable: true,
            text: "Hibernates after 3 hours without input on mains power (plan: Balanced).",
        },
        {
            id: POWER_FINDING.lidClose,
            power: "ac",
            action: "sleep",
            plans: ["Balanced"],
            fixable: true,
            text: "Closing the lid on mains power puts it to sleep (plan: Balanced).",
        },
        {
            id: POWER_FINDING.batterySleep,
            power: "dc",
            afterSeconds: 900,
            plans: ["Balanced"],
            fixable: false,
            text: "On battery it sleeps after 15 minutes without input and sleeps when the lid closes (plan: Balanced); that is left as it is, so a laptop in a bag still sleeps.",
        },
        {
            id: POWER_FINDING.updateRestart,
            window: { fromHour: 17, toHour: 8 },
            fixable: false,
            text: "Windows Update may restart it between 17:00 and 08:00 local time, outside its active hours; after a restart nothing runs again until somebody signs in, since the agent and Docker Desktop start at sign-in.",
        },
    ]);
    expect(power.battery).toBe(true);
});

// A night like rog's on 2026-11-22: two of the vendor's plans sleep after 5 hours plugged in, and either may be the active one.
test("the plans that hold a value are all named, the timeout is the shortest, and a span is said where they differ", () => {
    const rog = reading([
        plan("Performance", { standbyIdle: { ac: 18_000, dc: 0 } }),
        plan("Balanced", { standbyIdle: { ac: 0, dc: 0 } }),
        plan("Turbo", { standbyIdle: { ac: 18_000, dc: 0 } }, true),
    ]);
    expect(windowsFindings(rog).findings).toEqual([
        {
            id: POWER_FINDING.sleepIdle,
            power: "ac",
            afterSeconds: 18_000,
            plans: ["Performance", "Turbo"],
            fixable: true,
            text: "Sleeps after 5 hours without input on mains power (plans: Performance, Turbo).",
        },
    ]);
    const mixed = reading([plan("Silent", { standbyIdle: { ac: 1800, dc: 0 } }), plan("Turbo", { standbyIdle: { ac: 18_000, dc: 0 } }, true)]);
    expect(windowsFindings(mixed).findings[0]).toMatchObject({ afterSeconds: 1800, text: "Sleeps after 30 minutes to 5 hours without input on mains power (plans: Silent, Turbo)." });
});

test("a desktop without battery or lid: the lid every plan carries and battery are never findings", () => {
    const desktop = reading(
        [
            plan("Balanced", { standbyIdle: { ac: 1800, dc: 900 }, hibernateIdle: { ac: 0, dc: 0 }, lidAction: { ac: 1, dc: 1 } }, true),
            plan("High performance", { standbyIdle: { ac: 0, dc: 0 }, lidAction: { ac: 1, dc: 1 } }),
        ],
        { battery: false, lid: false, modernStandby: false },
    );
    const power = windowsFindings(desktop);
    expect(power.findings.map((finding) => finding.id)).toEqual([POWER_FINDING.sleepIdle]);
    expect(power.findings[0]?.plans).toEqual(["Balanced"]);
    expect(power.battery).toBe(false);
});

// A vendor's plan may lack settings outright; Modern Standby's network setting is absent off Modern Standby hardware.
test("a plan without a setting is no finding for it, and the other plans still are", () => {
    const vendor = reading([plan("Vendor", {}, true), plan("Balanced", { hibernateIdle: { ac: 3600, dc: 3600 } })], { battery: false });
    expect(windowsFindings(vendor).findings).toEqual([
        {
            id: POWER_FINDING.hibernateIdle,
            power: "ac",
            afterSeconds: 3600,
            plans: ["Balanced"],
            fixable: true,
            text: "Hibernates after 1 hour without input on mains power (plan: Balanced).",
        },
    ]);
    expect(windowsFindings(reading([plan("Vendor", {})])).findings).toEqual([]);
});

test("the network cut in standby is a finding only on Modern Standby, and only where a plan disables it", () => {
    const cut = [plan("Balanced", { standbyConnectivity: { ac: 0, dc: 0 } }, true)];
    expect(windowsFindings(reading(cut, { battery: false })).findings).toEqual([
        {
            id: POWER_FINDING.standbyNetwork,
            power: "ac",
            plans: ["Balanced"],
            fixable: true,
            text: "When the screen turns off on mains power, Modern Standby cuts the network (plan: Balanced): whatever a sandbox calls out to fails until somebody wakes the computer.",
        },
    ]);
    expect(windowsFindings(reading(cut, { modernStandby: undefined })).findings).toEqual([]);
    expect(windowsFindings(reading([plan("Balanced", { standbyConnectivity: { ac: 2, dc: 0 } })])).findings).toEqual([]);
});

test("hibernate at 0x7FFFFFFF or more is never, the lid's other actions are named, and an unknown one is said plainly", () => {
    const quiet = reading([plan("Balanced", { hibernateIdle: { ac: 0xff_ff_ff_ff, dc: 0x7f_ff_ff_ff } })], { battery: false });
    expect(windowsFindings(quiet).findings).toEqual([]);
    const lids = reading([plan("A", { lidAction: { ac: 3, dc: 0 } }), plan("B", { lidAction: { ac: 2, dc: 0 } }, true)], { battery: false });
    expect(windowsFindings(lids).findings[0]).toMatchObject({ action: "hibernate", plans: ["A", "B"], text: "Closing the lid on mains power hibernates it (plans: A, B)." });
    const odd = windowsFindings(reading([plan("A", { lidAction: { ac: 7, dc: 0 } })], { battery: false })).findings[0];
    expect(odd?.action).toBeUndefined();
    expect(odd?.text).toBe("Closing the lid on mains power stops it (plan: A).");
});

test("only mains-power findings are fixable: battery and update restarts never are", () => {
    expect(fixablePowerFindings(windowsFindings(LAPTOP)).map((finding) => finding.id)).toEqual([POWER_FINDING.sleepIdle, POWER_FINDING.hibernateIdle, POWER_FINDING.lidClose]);
    expect(windowsFindings(LAPTOP).findings.filter((finding) => finding.power === "dc").every((finding) => !finding.fixable)).toBe(true);
});
