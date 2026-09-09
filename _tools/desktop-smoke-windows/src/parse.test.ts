import { expect, test } from "vitest";
import {
    assistantReplied,
    asList,
    containerNames,
    controlTokenStore,
    desktopReadiness,
    dockerOsType,
    humanDuration,
    installedApp,
    lockScreenHolds,
    missingEnvNames,
    nonEmpty,
    publishedPort,
    runnerSupervision,
    sameStore,
    sandboxContainerName,
    sandboxSlug,
    titled,
    webView2Version,
} from "./parse.js";

// Pins the pure parsing/decision functions, the only assertions here that don't need a Windows machine; the IO
// (install, window mapping) isn't tested.

test("ConvertTo-Json's three shapes all read as a list", () => {
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
    expect(sandboxSlug(`winsmoke.e2e.test`)).toBe(`winsmoke`);
    expect(sandboxContainerName(`winsmoke.e2e.test`)).toBe(`intentic-sandbox-winsmoke`);
    expect(sandboxContainerName(`work`)).toBe(`intentic-sandbox-work`);
});

test("a published host port is read off docker port, and its absence is not a port", () => {
    expect(publishedPort(`127.0.0.1:28122\n`)).toBe(28122);
    // Dual-stack publish (0.0.0.0 and [::]): same port either line.
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
    // CRLF variant: what a heredoc crossing two argument parsers can do, and the daemon still accepts it.
    expect(sameStore(store, store.replace(`{"tokens"`, `{\r\n"tokens"`))).toBe(true);
    expect(sameStore(store, controlTokenStore(`cafebabe`))).toBe(false);
    // Empty/truncated JSON: what a heredoc that never saw its terminator would leave behind.
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
    // No task and a task at Ready are the same answer: this process wasn't started by it.
    expect(runnerSupervision([]).kind).toBe(`hand-started`);
    expect(runnerSupervision([{ State: `Ready`, Repetition: `PT3M` }]).kind).toBe(`hand-started`);

    // Provisioned before the watchdog existed: running, but a crash still needs a person.
    expect(runnerSupervision([{ State: `Running` }]).kind).toBe(`no-watchdog`);
    expect(runnerSupervision([{ State: `Running`, Repetition: `` }]).kind).toBe(`no-watchdog`);
    expect(runnerSupervision([{ State: `Running`, Repetition: `  ` }]).kind).toBe(`no-watchdog`);

    // Windows' own casing is Windows' business.
    expect(runnerSupervision([{ State: `running`, Repetition: `PT3M` }])).toEqual({ kind: `supervised`, repetition: `PT3M` });
});

test("a container's environment answers which names arrived, and an empty value never counts as one", () => {
    const inspected = `PATH=/usr/bin\nSANDBOX_GRANT=ig1.abc\nINGRESS_URL=https://ingress.e2e.test\n`;
    expect(missingEnvNames(inspected, [`SANDBOX_GRANT`, `INGRESS_URL`])).toEqual([]);

    // Names absent entirely: what passing them nowhere upstream looks like.
    expect(missingEnvNames(`PATH=/usr/bin\nCONNECT_TOKEN=tok\n`, [`SANDBOX_GRANT`, `INGRESS_URL`])).toEqual([`SANDBOX_GRANT`, `INGRESS_URL`]);

    // Set-but-empty must count as missing, or the bug would read as fixed.
    expect(missingEnvNames(`SANDBOX_GRANT=\nINGRESS_URL=   \n`, [`SANDBOX_GRANT`, `INGRESS_URL`])).toEqual([`SANDBOX_GRANT`, `INGRESS_URL`]);

    // A value containing `=` is still one value (base64/signed grants end in padding).
    expect(missingEnvNames(`SANDBOX_GRANT=ig1.YWJj==\n`, [`SANDBOX_GRANT`])).toEqual([]);
    // CRLF passes through; an empty dump names everything asked for as missing.
    expect(missingEnvNames(`SANDBOX_GRANT=ig1.abc\r\n`, [`SANDBOX_GRANT`])).toEqual([]);
    expect(missingEnvNames(``, [`SANDBOX_GRANT`])).toEqual([`SANDBOX_GRANT`]);
});

test("a repetition interval is reported in the units a person reads", () => {
    expect(humanDuration(`PT3M`)).toBe(`3 minutes`);
    expect(humanDuration(`PT1M`)).toBe(`1 minute`);
    expect(humanDuration(`PT1H`)).toBe(`1 hour`);
    expect(humanDuration(`PT1H30M`)).toBe(`1 hour 30 minutes`);
    expect(humanDuration(`PT30S`)).toBe(`30 seconds`);
    // Unrecognized shapes pass through rather than being guessed at.
    expect(humanDuration(`P99999999DT23H59M59S`)).toBe(`P99999999DT23H59M59S`);
    expect(humanDuration(`  PT5M  `)).toBe(`5 minutes`);
    expect(humanDuration(``)).toBe(``);
});

/* Whether this desktop can be driven, the check whose absence cost two red releases: the doctor looked for the
 * foreground window in the WINDOW LIST, the lock screen is the one holder that has no row in it, and "none
 * holding the foreground" was printed about a machine on which nothing could be given the keyboard. */

const idle = { locked: false, foreground: undefined } as const;
const lockScreen = { locked: false, foreground: { id: "66048", title: "Windows Default Lock Screen", app: "LockApp" } } as const;
const listed = (id: string, title: string) => ({ id, title, app: "intentic", bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: false });

test("an idle desktop with windows on it is drivable, and says how many", () => {
    const verdict = desktopReadiness([listed("21", "Intentic"), listed("22", "Set up a sandbox?")], idle);
    expect(verdict.drivable).toBe(true);
    expect(verdict.summary).toBe(`2 window(s) currently open, none holding the foreground`);
});

test("an ordinary window holding the foreground is drivable: the tiers take it off one every run", () => {
    const verdict = desktopReadiness([listed("21", "Intentic")], { locked: false, foreground: { id: "21", title: "Intentic", app: "intentic" } });
    expect(verdict.drivable).toBe(true);
    expect(verdict.summary).toContain(`"Intentic" [intentic] holding the foreground`);
    expect(verdict.remedy).toBeUndefined();
});

// The exact machine state of the failing release: nine windows, and the keyboard held by none of them.
test("a lock screen holding the keyboard is refused, however ordinary the window count looks", () => {
    const verdict = desktopReadiness([listed("21", "Intentic")], lockScreen);
    expect(verdict.drivable).toBe(false);
    expect(verdict.summary).toContain(`the lock screen still holds the foreground`);
    expect(verdict.remedy).toContain(`Stop-Process -Name LockApp`);
});

test("a session showing the sign-in screen is refused with the remedy a person can act on", () => {
    const verdict = desktopReadiness([], { locked: true, foreground: lockScreen.foreground });
    expect(verdict.drivable).toBe(false);
    expect(verdict.summary).toContain(`drawing its sign-in screen`);
    expect(verdict.remedy).toContain(`setup-windows-runner.ps1 -Repair -KeepAwake`);
});

// Drivable, but never again silently: a holder with no row is how the lock screen arrived, and the next one
// should be described rather than counted as nobody.
test("a holder no enumeration returns is named as one", () => {
    const verdict = desktopReadiness([listed("21", "Intentic")], {
        locked: false,
        foreground: { id: "9001", title: "", app: "ApplicationFrameHost" },
    });
    expect(verdict.drivable).toBe(true);
    expect(verdict.summary).toContain(
        `an untitled window [ApplicationFrameHost] holding the foreground, a window no enumeration of this desktop returns`,
    );
});

test("both lock screen programs count, whatever case Windows spells them in", () => {
    expect(lockScreenHolds(lockScreen)).toBe(true);
    expect(lockScreenHolds({ locked: true, foreground: { id: "3", title: "", app: "logonui" } })).toBe(true);
    expect(lockScreenHolds({ locked: false, foreground: { id: "4", title: "Intentic", app: "intentic" } })).toBe(false);
    expect(lockScreenHolds(idle)).toBe(false);
});
