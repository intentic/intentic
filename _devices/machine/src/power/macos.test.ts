import { HostPowerSchema, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { macFindings, pmsetFrom } from "./macos.js";

/* WHAT A MAC WOULD DO TO WORK LEFT RUNNING, from `pmset -g custom`: the AC section's `sleep`, never `displaysleep` or
   `disksleep`, and the lid said only on a Mac with a battery. */

const MACBOOK = [
    "Battery Power:",
    " Sleep On Power Button 1",
    " lowpowermode         0",
    " standby              1",
    " sleep                1",
    " displaysleep         2",
    " disksleep            10",
    "AC Power:",
    " Sleep On Power Button 1",
    " standby              1",
    " sleep                10 (sleep prevented by coreaudiod)",
    " displaysleep         10",
    " disksleep            10",
    "",
].join("\n");

const MAC_MINI = ["AC Power:", " sleep                0", " displaysleep         10", " disksleep            10", ""].join("\n");

test("a MacBook that sleeps after 10 minutes on mains power is a finding with pmset's command, and says the lid sleeps it anyway", () => {
    expect(pmsetFrom(MACBOOK)).toEqual({ acSleepMinutes: 10, battery: true });
    const power = macFindings({ at: 1000, utcOffsetMinutes: -300, ...pmsetFrom(MACBOOK) });
    expect(HostPowerSchema.parse(power)).toEqual(power);
    expect(power.findings).toEqual([
        {
            id: POWER_FINDING.osSleep,
            power: "ac",
            afterSeconds: 600,
            fixable: false,
            command: "sudo pmset -c sleep 0",
            text: "Sleeps after 10 minutes without input on mains power (pmset's AC sleep). Closing the lid sleeps a Mac whatever this says, unless an external display is attached.",
        },
    ]);
});

test("a Mac mini set never to sleep has nothing to say, and no battery", () => {
    expect(pmsetFrom(MAC_MINI)).toEqual({ acSleepMinutes: 0, battery: false });
    expect(macFindings({ at: 1000, utcOffsetMinutes: 0, ...pmsetFrom(MAC_MINI) })).toEqual({ at: 1000, utcOffsetMinutes: 0, battery: false, findings: [] });
});

test("a desktop Mac that sleeps is told without the lid", () => {
    const power = macFindings({ at: 1000, utcOffsetMinutes: 0, acSleepMinutes: 90, battery: false });
    expect(power.findings[0]?.text).toBe("Sleeps after 1 hour 30 minutes without input on mains power (pmset's AC sleep).");
});
