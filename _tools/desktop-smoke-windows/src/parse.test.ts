import { expect, test } from "vitest";
import {
    assistantReplied,
    asList,
    containerNames,
    controlTokenStore,
    dockerOsType,
    humanDuration,
    installedApp,
    nonEmpty,
    publishedPort,
    runnerSupervision,
    sameStore,
    sandboxContainerName,
    sandboxSlug,
    titled,
    webView2Version,
} from "./parse.js";

/* These are the only assertions in this package that can be made without a Windows machine, which is exactly
 * why every decision the tiers make was pushed into a pure function to begin with. What is left unasserted here
 * is real IO: an installer running, a window mapping, and no unit test was ever going to reach it. */

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

test("the quotes Windows stores around InstallLocation are stripped, and the ones around UninstallString are not", () => {
    // What the real registry holds, and the install tier reads the location with readdir, which treats a
    // leading quote as an ordinary path character and resolves the lot relative to the working directory.
    // The uninstall string keeps its quotes: that one goes to a shell, which needs them to survive a space.
    const entries = [
        {
            DisplayName: `Intentic`,
            DisplayVersion: `1.184.0`,
            InstallLocation: `"C:\\Users\\ci\\AppData\\Local\\Intentic"`,
            UninstallString: `"C:\\Users\\ci\\AppData\\Local\\Intentic\\uninstall.exe"`,
        },
    ];
    expect(installedApp(entries, `Intentic`)).toEqual({
        name: `Intentic`,
        version: `1.184.0`,
        installLocation: `C:\\Users\\ci\\AppData\\Local\\Intentic`,
        uninstallString: `"C:\\Users\\ci\\AppData\\Local\\Intentic\\uninstall.exe"`,
    });
});

test("an entry whose InstallLocation is only quotes is no location at all", () => {
    expect(installedApp([{ DisplayName: `Intentic`, InstallLocation: `""` }], `Intentic`)).toBeUndefined();
});

test("an entry with no InstallLocation is not the install: a guessed path would name the wrong cause", () => {
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

test("a published host port is read off docker port, and its absence is not a port", () => {
    /* The distinction this whole probe exists for: a container that publishes the loopback listener and one
     * that does not both answer `docker port` with exit 0, and the second says nothing at all. Reading that
     * silence as "no port" is what lets tier 3 tell its own sandbox from whoever else holds the address. */
    expect(publishedPort(`127.0.0.1:28122\n`)).toBe(28122);
    // Both families, for a publish that was not scoped to loopback: the port is the same on either line.
    expect(publishedPort(`0.0.0.0:28122\n[::]:28122\n`)).toBe(28122);
    expect(publishedPort(`127.0.0.1:28122\r\n`)).toBe(28122);
    expect(publishedPort(``)).toBeUndefined();
    expect(publishedPort(`\n \n`)).toBeUndefined();
});

test("container names come back one per line, whatever the shell's line endings", () => {
    expect(containerNames(`intentic-sandbox-winsmoke\nintentic-sandbox-work\n`)).toEqual([`intentic-sandbox-winsmoke`, `intentic-sandbox-work`]);
    expect(containerNames(`intentic-sandbox-winsmoke\r\n`)).toEqual([`intentic-sandbox-winsmoke`]);
    expect(containerNames(`\n`)).toEqual([]);
});

test("the seeded store is compared as the daemon reads it, not as bytes", () => {
    const store = controlTokenStore(`deadbeef`);
    expect(sameStore(store, `${store}\n`)).toBe(true);
    // The seed is a multi-line heredoc crossing two argument parsers on Windows: CRLF is a store the daemon
    // still accepts, and a truncated one is not.
    expect(sameStore(store, store.replace(`{"tokens"`, `{\r\n"tokens"`))).toBe(true);
    expect(sameStore(store, controlTokenStore(`cafebabe`))).toBe(false);
    // The failure this catches: a shell that never saw the end of the heredoc writes an empty file and exits 0.
    expect(sameStore(store, ``)).toBe(false);
    expect(sameStore(store, `{"tokens":[`)).toBe(false);
});

test("a title matches on its distinctive half, so reworded copy does not go red", () => {
    const open = [`Intentic, Setting up your sandbox`, `Program Manager`];
    expect(titled(open, `Setting up`)).toBe(true);
    expect(titled(open, `Intentic`)).toBe(true);
    expect(titled(open, `Set up a sandbox on this device`)).toBe(false);
    expect(titled([], `Intentic`)).toBe(false);
});

test("the WebView2 version is the first client key that carries one", () => {
    expect(webView2Version([{ pv: `` }, { pv: `139.0.3405.86` }])).toBe(`139.0.3405.86`);
    expect(webView2Version([])).toBeUndefined();
    expect(webView2Version([{}])).toBeUndefined();
});

test("a runner nobody supervises is told apart from the logon task's", () => {
    // The doctor runs INSIDE the listener, so a task that is not `Running` did not start this process — which
    // makes "no such task" and "a task sitting at Ready" the same answer, and the answer that matters: this
    // runner is a console window somebody opened, and it is gone at the next reboot.
    expect(runnerSupervision([]).kind).toBe(`hand-started`);
    expect(runnerSupervision([{ State: `Ready`, Repetition: `PT3M` }]).kind).toBe(`hand-started`);

    // A machine provisioned before the watchdog existed: the task is what is running, but a crash still needs a
    // person, so it must not read as fully unattended.
    expect(runnerSupervision([{ State: `Running` }]).kind).toBe(`no-watchdog`);
    expect(runnerSupervision([{ State: `Running`, Repetition: `` }]).kind).toBe(`no-watchdog`);
    expect(runnerSupervision([{ State: `Running`, Repetition: `  ` }]).kind).toBe(`no-watchdog`);

    // Windows' own casing is Windows' business.
    expect(runnerSupervision([{ State: `running`, Repetition: `PT3M` }])).toEqual({ kind: `supervised`, repetition: `PT3M` });
});

test("a repetition interval is reported in the units a person reads", () => {
    expect(humanDuration(`PT3M`)).toBe(`3 minutes`);
    expect(humanDuration(`PT1M`)).toBe(`1 minute`);
    expect(humanDuration(`PT1H`)).toBe(`1 hour`);
    expect(humanDuration(`PT1H30M`)).toBe(`1 hour 30 minutes`);
    expect(humanDuration(`PT30S`)).toBe(`30 seconds`);
    // Anything else is passed through rather than guessed at: a wrong number here would be a confident lie
    // about how long this machine takes to heal itself.
    expect(humanDuration(`P99999999DT23H59M59S`)).toBe(`P99999999DT23H59M59S`);
    expect(humanDuration(`  PT5M  `)).toBe(`5 minutes`);
    expect(humanDuration(``)).toBe(``);
});
