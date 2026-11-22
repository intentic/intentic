import { HostPowerSchema, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { cannotSuspend, gsettingsNumber, gsettingsWord, lidFrom, linuxFindings, type LinuxPowerReading, logindFrom, MASK_COMMAND, sleepTargetsFrom } from "./linux.js";

/* WHAT A LINUX HOST WOULD DO TO WORK LEFT RUNNING, from what systemctl, busctl and gsettings answer. The answers below
   are z440's and radarsu-server's as read on 2026-11-22. */

const reading = (rest: Partial<LinuxPowerReading>): LinuxPowerReading => ({
    at: 1000,
    utcOffsetMinutes: 60,
    sleepTargets: ["static", "static", "static", "static"],
    lid: false,
    lidAction: "suspend",
    idleAction: "ignore",
    idleSeconds: 1800,
    gnome: undefined,
    battery: undefined,
    ...rest,
});

// Both servers' logind: HandleLidSwitch suspend, HandleLidSwitchExternalPower unset, IdleAction ignore after 30 minutes.
const LOGIND = 's "suspend"\ns ""\ns "ignore"\nt 1800000000\n';

test("z440, its sleep targets all masked, cannot suspend: nothing to say", () => {
    const targets = sleepTargetsFrom("masked\nmasked\nmasked\nmasked\n");
    expect(cannotSuspend(targets)).toBe(true);
    expect(linuxFindings(reading({ sleepTargets: targets, lid: true, idleAction: "suspend" })).findings).toEqual([]);
    expect(cannotSuspend(["masked", "masked", "static", "masked"])).toBe(false);
    expect(cannotSuspend([])).toBe(false);
});

test("a server without a lid whose logind only suspends on the lid would not suspend: nothing to say", () => {
    expect(logindFrom(LOGIND)).toEqual({ lidAction: "suspend", idleAction: "ignore", idleSeconds: 1800 });
    expect(linuxFindings(reading(logindFrom(LOGIND))).findings).toEqual([]);
});

test("a laptop that suspends on the lid and after GNOME's idle timeout is one finding with the command that stops both", () => {
    const power = linuxFindings(reading({ lid: true, gnome: { type: "suspend", seconds: 900 }, battery: true }));
    expect(HostPowerSchema.parse(power)).toEqual(power);
    expect(power).toEqual({
        at: 1000,
        utcOffsetMinutes: 60,
        battery: true,
        findings: [
            {
                id: POWER_FINDING.osSleep,
                power: "ac",
                afterSeconds: 900,
                fixable: false,
                command: "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
                text: "Suspends after 15 minutes without input (GNOME's power settings) and when the lid closes on mains power (logind). Masking the sleep targets stops it, and needs root.",
            },
        ],
    });
});

test("logind's own idle action counts, the shortest timeout leads, and GNOME doing nothing is nothing", () => {
    const both = linuxFindings(reading({ idleAction: "suspend", idleSeconds: 3600, gnome: { type: "hibernate", seconds: 1200 } })).findings[0];
    expect(both?.afterSeconds).toBe(1200);
    expect(both?.text).toBe("Suspends after 20 minutes without input (GNOME's power settings) and after 1 hour without input (logind's IdleAction). Masking the sleep targets stops it, and needs root.");
    expect(both?.command).toBe(MASK_COMMAND);
    expect(linuxFindings(reading({ gnome: { type: "nothing", seconds: 1200 } })).findings).toEqual([]);
    expect(linuxFindings(reading({ idleAction: "suspend", idleSeconds: 0 })).findings).toEqual([]);
});

test("the lid on mains power is HandleLidSwitchExternalPower where set, and a lid is an ACPI button or a lid switch", () => {
    expect(logindFrom('s "suspend"\ns "ignore"\ns "ignore"\nt 0\n').lidAction).toBe("ignore");
    expect(lidFrom(["LID0"], undefined)).toBe(true);
    expect(lidFrom([], 'I: Bus=0019 Vendor=0000 Product=0005 Version=0000\nN: Name="Lid Switch"\nP: Phys=PNP0C0D/button/input0\n')).toBe(true);
    expect(lidFrom([], 'N: Name="Power Button"\n')).toBe(false);
});

test("gsettings' words and numbers are read with or without their type", () => {
    expect(gsettingsWord("'suspend'\n")).toBe("suspend");
    expect(gsettingsWord("No such schema")).toBeUndefined();
    expect(gsettingsNumber("1200\n")).toBe(1200);
    expect(gsettingsNumber("uint32 900\n")).toBe(900);
    expect(gsettingsNumber("'x'")).toBeUndefined();
});
