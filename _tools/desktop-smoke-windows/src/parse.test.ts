import { expect, test } from "vitest";
import {
    assistantReplied,
    asList,
    dockerOsType,
    installedApp,
    nonEmpty,
    sandboxContainerName,
    sandboxSlug,
    titled,
    webView2Version,
} from "./parse.js";

/* These are the only assertions in this package that can be made without a Windows machine, which is exactly
 * why every decision the tiers make was pushed into a pure function to begin with. What is left unasserted here
 * is real IO — an installer running, a window mapping — and no unit test was ever going to reach it. */

test("ConvertTo-Json's three shapes all read as a list", () => {
    // The footgun that fails on the machine with ONE match and passes on the developer's with two.
    expect(asList(``)).toEqual([]);
    expect(asList(`   \n `)).toEqual([]);
    expect(asList(`{"DisplayName":"Intentic"}`)).toEqual([{ DisplayName: `Intentic` }]);
    expect(asList(`[{"DisplayName":"Intentic"},{"DisplayName":"Other"}]`)).toHaveLength(2);
});

test("an unset repository variable and its empty Actions expansion both stand the credentialed tier down", () => {
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty(``)).toBeUndefined();
    expect(nonEmpty(`  `)).toBeUndefined();
    expect(nonEmpty(`agent-auth`)).toBe(`agent-auth`);
});

test("only the expected assistant bubble completes an agent turn", () => {
    expect(assistantReplied(`{"messages":[{"role":"user","text":"reply ready"}]}`, `ready`)).toBe(false);
    expect(assistantReplied(`{"messages":[{"role":"assistant","text":"ready"}]}`, `ready`)).toBe(true);
    expect(assistantReplied(`{"messages":[{"role":"assistant","text":" READY \\n"}]}`, `ready`)).toBe(true);
    expect(assistantReplied(`not json`, `ready`)).toBe(false);
});

test("the installed app is found by display name, across hives", () => {
    const entries = [
        { DisplayName: `7-Zip`, InstallLocation: `C:\\Program Files\\7-Zip` },
        {
            DisplayName: `Intentic`,
            DisplayVersion: `1.4.0`,
            InstallLocation: `C:\\Users\\ci\\AppData\\Local\\Intentic`,
            UninstallString: `"C:\\Users\\ci\\AppData\\Local\\Intentic\\uninstall.exe"`,
        },
    ];
    expect(installedApp(entries, `Intentic`)).toEqual({
        name: `Intentic`,
        version: `1.4.0`,
        installLocation: `C:\\Users\\ci\\AppData\\Local\\Intentic`,
        uninstallString: `"C:\\Users\\ci\\AppData\\Local\\Intentic\\uninstall.exe"`,
    });
});

test("an entry with no InstallLocation is not the install — a guessed path would name the wrong cause", () => {
    // Windows lists plenty of rows with no location. Treating one as the install turns a bundler regression
    // into a set of "file not found" failures that point at the app instead of at the package.
    expect(installedApp([{ DisplayName: `Intentic` }], `Intentic`)).toBeUndefined();
    expect(installedApp([{ DisplayName: `Intentic`, InstallLocation: `` }], `Intentic`)).toBeUndefined();
});

test("nothing installed reads as nothing installed", () => {
    expect(installedApp([], `Intentic`)).toBeUndefined();
    expect(installedApp([{ DisplayName: `Intentic Helper`, InstallLocation: `C:\\x` }], `Intentic`)).toBeUndefined();
});

test("the container OS is read as the daemon spells it", () => {
    expect(dockerOsType(`linux\n`)).toBe(`linux`);
    expect(dockerOsType(`Windows\r\n`)).toBe(`windows`);
    expect(dockerOsType(``)).toBeUndefined();
    expect(dockerOsType(`  \n`)).toBeUndefined();
});

test("the container name follows the slug rule every later flow addresses", () => {
    // recreate, cleanup and the launcher's docker reads all key off this name; the Linux setup tier asserts
    // the identical derivation.
    expect(sandboxSlug(`winsmoke.e2e.test`)).toBe(`winsmoke`);
    expect(sandboxContainerName(`winsmoke.e2e.test`)).toBe(`intentic-sandbox-winsmoke`);
    expect(sandboxContainerName(`work`)).toBe(`intentic-sandbox-work`);
});

test("a title matches on its distinctive half, so reworded copy does not go red", () => {
    const open = [`Intentic — Setting up your sandbox`, `Program Manager`];
    expect(titled(open, `Setting up`)).toBe(true);
    expect(titled(open, `Intentic`)).toBe(true);
    expect(titled(open, `Set up a sandbox on this computer`)).toBe(false);
    expect(titled([], `Intentic`)).toBe(false);
});

test("the WebView2 version is the first client key that carries one", () => {
    expect(webView2Version([{ pv: `` }, { pv: `139.0.3405.86` }])).toBe(`139.0.3405.86`);
    expect(webView2Version([])).toBeUndefined();
    expect(webView2Version([{}])).toBeUndefined();
});
