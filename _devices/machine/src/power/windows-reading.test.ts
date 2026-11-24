import { readFileSync } from "node:fs";
import { POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { windowsFindings } from "./windows-findings.js";
import {
    capabilitiesFrom,
    encodedCommand,
    idleSeconds,
    indexPairFrom,
    planListFrom,
    POWER_SETTINGS,
    WindowsAnswerSchema,
    powerAssemblyPath,
    windowsPowerScript,
    windowsReadingFrom,
} from "./windows-reading.js";

/* THE WINDOWS READ, from what PowerShell printed to the reading: nothing in it may depend on the language Windows speaks,
   since powercfg's labels are translated. The real answer is rog's, read 2026-11-22 after its owner had set every plan
   to stay on (rog-2026-11-22.fixture.json, the script's own stdout); the Polish and German answers are powercfg's
   layout with its labels translated. */

const NOW = Date.parse("2026-11-22T15:00:00.000Z");
const ROG = WindowsAnswerSchema.parse(JSON.parse(readFileSync(new URL("rog-2026-11-22.fixture.json", import.meta.url), "utf8")));

test("rog's reading has its four plans, Turbo active, every setting read, Modern Standby, a battery, a lid and active hours 8 to 2", () => {
    const reading = windowsReadingFrom(ROG, NOW);
    expect(reading.plans.map((plan) => [plan.name, plan.active])).toEqual([
        ["Performance", false],
        ["Balanced", false],
        ["Silent", false],
        ["Turbo", true],
    ]);
    expect(reading.plans.every((plan) => Object.values(plan.settings).every((pair) => pair !== null))).toBe(true);
    // Balanced holds 0x7fffffff for hibernate on battery: never, not 68 years.
    expect(reading.plans[1]?.settings.hibernateIdle).toEqual({ ac: 0, dc: 0x7f_ff_ff_ff });
    expect(idleSeconds(0x7f_ff_ff_ff)).toBe(0);
    expect(reading.plans[1]?.settings.standbyConnectivity).toEqual({ ac: 1, dc: 2 });
    expect([reading.modernStandby, reading.battery, reading.lid]).toEqual([true, true, true]);
    expect(reading.activeHours).toEqual({ start: 8, end: 2 });
    expect(reading.utcOffsetMinutes).toBe(60);
});

// What the owner set on rog after the night of 2026-11-22: nothing on mains power would stop work, only the restarts.
test("rog as it is now yields only the update restart, 02:00 to 08:00, and nothing stay-on would change", () => {
    const power = windowsFindings(windowsReadingFrom(ROG, NOW));
    expect(power.findings.map((finding) => finding.id)).toEqual([POWER_FINDING.updateRestart]);
    expect(power.findings[0]).toMatchObject({ window: { fromHour: 2, toHour: 8 }, fixable: false });
    expect(power.findings[0]?.text).toContain("between 02:00 and 08:00");
    expect(power).toMatchObject({ at: NOW, utcOffsetMinutes: 60, battery: true });
});

const POLISH_LIST = [
    "",
    "Istniejące schematy zasilania (* Aktywny)",
    "-----------------------------------",
    "Identyfikator GUID schematu zasilania: 381b4222-f694-41f0-9685-ff5bb260df2e  (Zrównoważony) *",
    "Identyfikator GUID schematu zasilania: 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C  (Wysoka wydajność)",
].join("\n");

const POLISH_SLEEP = [
    "Identyfikator GUID schematu zasilania: 381b4222-f694-41f0-9685-ff5bb260df2e  (Zrównoważony)",
    "  Identyfikator GUID podgrupy: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Uśpienie)",
    "    Alias identyfikatora GUID: SUB_SLEEP",
    "    Identyfikator GUID ustawienia zasilania: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Przejdź w tryb uśpienia po)",
    "      Alias identyfikatora GUID: STANDBYIDLE",
    "      Minimalne możliwe ustawienie: 0x00000000",
    "      Maksymalne możliwe ustawienie: 0xffffffff",
    "      Przyrost możliwych ustawień: 0x00000001",
    "      Jednostki możliwych ustawień: Sekundy",
    "    Indeks bieżącego ustawienia zasilania prądem przemiennym: 0x00004650",
    "    Indeks bieżącego ustawienia zasilania prądem stałym: 0x00000384",
].join("\n");

const GERMAN_LID = [
    "GUID des Energieschemas: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert)",
    "  GUID der Untergruppe: 4f971e89-eebd-4455-a8de-9e59040e7347  (Netzschalter und Zuklappen)",
    "    GUID-Alias: SUB_BUTTONS",
    "    Energieeinstellungs-GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Zuklappen)",
    "      GUID-Alias: LIDACTION",
    "      Index der möglichen Einstellung: 000",
    "      Anzeigename der möglichen Einstellung: Nichts unternehmen",
    "      Index der möglichen Einstellung: 001",
    "      Anzeigename der möglichen Einstellung: Energie sparen",
    "    Aktueller Wechselstrom-Einstellungsindex: 0x00000001",
    "    Aktueller Gleichstrom-Einstellungsindex: 0x00000002",
].join("\n");

test("the plan list is read by its GUIDs, brackets and star alone, in any language and any letter case", () => {
    expect(planListFrom(POLISH_LIST)).toEqual([
        { guid: "381b4222-f694-41f0-9685-ff5bb260df2e", name: "Zrównoważony", active: true },
        { guid: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", name: "Wysoka wydajność", active: false },
    ]);
    expect(planListFrom("GUID des Energieschemas: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert) *")).toEqual([
        { guid: "381b4222-f694-41f0-9685-ff5bb260df2e", name: "Ausbalanciert", active: true },
    ]);
});

test("a setting's AC and DC index are the last two 0x numbers of its answer, whatever the labels say", () => {
    expect(indexPairFrom({ code: 0, text: POLISH_SLEEP }, POWER_SETTINGS.standbyIdle.setting)).toEqual({ ac: 18_000, dc: 900 });
    expect(indexPairFrom({ code: 0, text: GERMAN_LID }, POWER_SETTINGS.lidAction.setting)).toEqual({ ac: 1, dc: 2 });
});

// A plan without the setting makes powercfg exit 1 with a sentence on stderr and nothing on stdout (rog, 2026-11-22).
test("a setting the plan does not have, an answer about another setting, or one without two numbers reads as absent", () => {
    expect(indexPairFrom({ code: 1, text: "" }, POWER_SETTINGS.standbyIdle.setting)).toBeNull();
    expect(indexPairFrom({ code: 0, text: GERMAN_LID }, POWER_SETTINGS.standbyIdle.setting)).toBeNull();
    expect(indexPairFrom({ code: 0, text: `${POWER_SETTINGS.lidAction.setting}\nAC: 0x00000001` }, POWER_SETTINGS.lidAction.setting)).toBeNull();
    expect(indexPairFrom({ code: null, text: null }, POWER_SETTINGS.lidAction.setting)).toBeNull();
});

test("the capabilities' bytes say lid, Modern Standby and battery at their offsets, and too few bytes say nothing", () => {
    const bytes = Buffer.alloc(76);
    bytes[2] = 1;
    bytes[30] = 1;
    expect(capabilitiesFrom(bytes.toString("base64"))).toEqual({ lid: true, modernStandby: false, battery: true });
    expect(capabilitiesFrom(Buffer.alloc(10).toString("base64"))).toEqual({ lid: undefined, modernStandby: undefined, battery: undefined });
    expect(capabilitiesFrom(null)).toEqual({ lid: undefined, modernStandby: undefined, battery: undefined });
});

// Constrained language mode refuses Add-Type: the names are powercfg's, the battery Win32_Battery's, and the rest unknown.
test("without the native read the plans keep powercfg's names, the battery comes from CIM, and Modern Standby and the lid are unknown", () => {
    const answer = WindowsAnswerSchema.parse({
        list: POLISH_LIST,
        // PowerShell writes a lone object where an array had one element.
        queries: { plan: "381b4222-f694-41f0-9685-ff5bb260df2e", setting: POWER_SETTINGS.standbyIdle.setting, code: 0, text: POLISH_SLEEP },
        names: {},
        capabilities: null,
        nativeError: "Cannot add type. Definition of new types is not supported in this language mode.",
        battery: true,
        activeHoursStart: null,
        activeHoursEnd: null,
        utcOffsetMinutes: 60,
    });
    const reading = windowsReadingFrom(answer, NOW);
    expect(reading.plans.map((plan) => plan.name)).toEqual(["Zrównoważony", "Wysoka wydajność"]);
    expect(reading.plans[0]?.settings).toEqual({ standbyIdle: { ac: 18_000, dc: 900 }, hibernateIdle: null, lidAction: null, standbyConnectivity: null });
    expect([reading.battery, reading.modernStandby, reading.lid, reading.activeHours]).toEqual([true, undefined, undefined, undefined]);
});

test("a value PowerShell writes oddly reads as unknown, never as a failed read", () => {
    const answer = WindowsAnswerSchema.parse({ list: "", queries: null, names: "x", capabilities: 4, battery: "yes", activeHoursStart: 30, activeHoursEnd: 2, utcOffsetMinutes: -300 });
    expect(answer).toMatchObject({ queries: [], names: null, capabilities: null, battery: null, activeHoursStart: null, activeHoursEnd: 2 });
    expect(windowsReadingFrom(answer, NOW).activeHours).toBeUndefined();
});

test("the script asks for every setting by GUID and answers in ASCII, and travels as UTF-16LE base64", () => {
    const script = windowsPowerScript("C:\\Users\\o'brien\\.intentic\\machine\\cache\\intentic-power-x.dll");
    for (const { sub, setting } of Object.values(POWER_SETTINGS)) {
        expect(script).toContain(`sub = '${sub}'; setting = '${setting}'`);
    }
    expect(script).toContain("powercfg.exe /qh $plan $s.sub $s.setting");
    expect(script).toContain("[^\\x00-\\x7e]");
    // The here-string's opening and closing marks stand on lines of their own, as PowerShell requires.
    expect(script.split("\n")).toEqual(expect.arrayContaining(["$native = @'", "'@"]));
    expect(Buffer.from(encodedCommand(script), "base64").toString("utf16le")).toBe(script);
});

test("the C# is compiled into a DLL once and loaded from it after, falling back to an in-memory compile", () => {
    const script = windowsPowerScript("C:\\Users\\o'brien\\cache\\intentic-power-x.dll");
    // The path is a single-quoted literal, its quote doubled.
    expect(script).toContain("$assembly = 'C:\\Users\\o''brien\\cache\\intentic-power-x.dll'");
    // Compiled to a part file and renamed into place, only when the DLL is not there yet, and only when the type is not loaded.
    expect(script).toContain("if (-not ('IntenticPower' -as [type])) {");
    expect(script).toContain("if (-not (Test-Path -LiteralPath $assembly)) {");
    expect(script).toContain("Add-Type -TypeDefinition $native -OutputAssembly $part -OutputType Library");
    expect(script).toContain("Add-Type -LiteralPath $assembly");
    // A DLL that will not load is deleted and the type compiled in memory, as before.
    expect(script).toContain("catch { Remove-Item -LiteralPath $assembly -Force -ErrorAction SilentlyContinue; Add-Type -TypeDefinition $native }");
    // The compile-to-file must come before the load in the script.
    expect(script.indexOf("-OutputAssembly")).toBeLessThan(script.indexOf("Add-Type -LiteralPath"));
});

test("the DLL is named by the C#'s own hash, in the agent's cache folder", () => {
    const path = powerAssemblyPath("/home/x/.intentic/machine/cache");
    expect(path).toMatch(/^\/home\/x\/\.intentic\/machine\/cache\/intentic-power-[0-9a-f]{16}\.dll$/);
    expect(powerAssemblyPath("/home/x/.intentic/machine/cache")).toBe(path);
});
