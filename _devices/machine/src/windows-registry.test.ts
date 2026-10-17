import { PS_UTF8_OUTPUT } from "@intentic/desktop-automation";
import { registryValueFrom, registryValueScript } from "./windows-registry.js";

// What PowerShell 5.1 prints for the script, as ConvertTo-Json -Compress spells it: a hashtable's keys in any order,
// `'` as \u0027, and everything else UTF-8 under the pin.
// Plain strings, not String.raw: Bun's transpiler rewrites a template's non-ASCII letters as \u escapes in its raw text.
describe("registryValueFrom", () => {
    it("reads the value as stored, in any language, and names its kind as reg.exe does", () => {
        const path = '{"data":"%USERPROFILE%\\\\bin;C:\\\\Użytkownicy\\\\Zażółć\\\\narzędzia","kind":"ExpandString"}\r\n';
        expect(registryValueFrom(path)).toEqual({ kind: "REG_EXPAND_SZ", data: "%USERPROFILE%\\bin;C:\\Użytkownicy\\Zażółć\\narzędzia" });
        const run = '{"kind":"String","data":"\\"C:\\\\Users\\\\Zażółć\\\\mutagen.exe\\" \\"daemon\\" \\u0027start\\u0027"}';
        expect(registryValueFrom(run)).toEqual({ kind: "REG_SZ", data: '"C:\\Users\\Zażółć\\mutagen.exe" "daemon" \'start\'' });
        expect(registryValueFrom(`{"kind":"MultiString","data":"a b"}`)?.kind).toBe("REG_MULTI_SZ");
    });

    it("tells an absent value from an empty one", () => {
        expect(registryValueFrom(`{"kind":"","data":""}`)).toBeUndefined();
        expect(registryValueFrom(`{"kind":"String","data":""}`)).toEqual({ kind: "REG_SZ", data: "" });
    });

    // The value is written back whole, so an answer that is not one must not read as "no value".
    it("throws on an answer that is not one, rather than reading it as absent", () => {
        expect(() => registryValueFrom("")).toThrow();
        expect(() => registryValueFrom("Get-Item : Cannot find path")).toThrow();
        expect(() => registryValueFrom(`{"kind":"String"}`)).toThrow();
    });
});

describe("registryValueScript", () => {
    it("asks for UTF-8, stops on any error, and reads the value unexpanded", () => {
        const script = registryValueScript("HKCU:\\Environment", "Path");
        expect(script.startsWith(PS_UTF8_OUTPUT)).toBe(true);
        expect(script).toContain("$ErrorActionPreference = 'Stop'");
        expect(script).toContain("'DoNotExpandEnvironmentNames'");
        // The key and name travel as data, never inside a quoted literal.
        expect(script).not.toContain("Environment'");
    });
});
