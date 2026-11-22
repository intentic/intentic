// What one computer offers a person, environment by environment: nothing for a row with no command door, one reason for
// both buttons when the computer cannot be reached or cannot do it, the switch that is off when one is, and no screen
// button at all on a side that has no screen.
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { listedDevice } from "../../../../testing/listedDevice";
import { deviceRow } from "../deviceRows";
import type { RemoteStatus } from "./remoteApi";
import { environmentName, primaryMonitor, remoteSide, statusWanted, terminalTitle } from "./remoteOffers";

const row = (overrides: Partial<Device> = {}) =>
    deviceRow(listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true, platform: `windows`, ...overrides }), undefined);

const monitor = { id: `0`, name: `DELL U2720Q`, x: 0, y: 0, width: 3840, height: 2160, scale: 1.5, primary: true };

const status = (overrides: Partial<RemoteStatus> = {}): RemoteStatus => ({
    available: true,
    allow: { view: true, control: true, terminal: true },
    monitors: [monitor],
    environments: [`native`],
    terminals: [],
    ...overrides,
});

it("offers nothing on a row with no command door", () => {
    expect(remoteSide(row({ hostId: undefined }), undefined)).toBeUndefined();
});

it("says once why an offline computer offers nothing, without asking the sandbox", () => {
    const offline = row({ online: false });
    expect(statusWanted(offline)).toBe(false);
    expect(remoteSide(offline, undefined)).toMatchObject({
        blocked: `rog is offline.`,
        checking: false,
        screen: { ready: false, reason: `rog is offline.` },
        terminal: { ready: false, reason: `rog is offline.` },
    });
});

it("names the agent as what is in the way where it predates remote access", () => {
    // SAFETY: a fixture's facts, holding only the field this reads; the rest of DeviceFacts is optional to the rule.
    const older = row({ facts: { features: [`sleep`] } as Device[`facts`] });
    expect(statusWanted(older)).toBe(false);
    expect(remoteSide(older, undefined)?.blocked).toBe(`Update the agent on rog to reach its screen and terminals.`);
});

it("asks a computer that says nothing of its features, and waits for the answer without a reason", () => {
    expect(statusWanted(row())).toBe(true);
    const waiting = remoteSide(row(), { kind: `waiting` });
    expect(waiting).toMatchObject({ checking: true, screen: { ready: false, reason: `` }, terminal: { ready: false, reason: `` } });
    expect(waiting?.blocked).toBeUndefined();
});

it("shows the sandbox's own sentence when it refuses or the computer is not available", () => {
    const refused = remoteSide(row(), { kind: `refused`, reason: `This sandbox's netd is too old for remote access.` });
    expect(refused?.blocked).toBe(`This sandbox's netd is too old for remote access.`);
    const unavailable = remoteSide(row(), { kind: `answered`, status: status({ available: false, reason: `Every remote switch is off.` }) });
    expect(unavailable?.terminal).toEqual({ ready: false, reason: `Every remote switch is off.` });
});

it("opens what its switches allow, and names the one that is off", () => {
    const side = remoteSide(row(), { kind: `answered`, status: status({ allow: { view: false, control: false, terminal: true } }) });
    expect(side?.screen).toEqual({ ready: false, reason: `Seeing the screen is off in this computer’s permissions.` });
    expect(side?.terminal).toEqual({ ready: true });
    expect(side?.monitors).toEqual([monitor]);
});

it("draws no screen button on a distro, which has no screen of its own", () => {
    const distro = row({ key: `rog-arch`, hostId: `rog::wsl:archlinux`, platform: `linux` });
    // Even were a monitor named there (a Linux remoted in WSL seeing WSLg's display), the PC's screen is the Windows side's.
    const side = remoteSide(distro, { kind: `answered`, status: status({ environments: [`wsl:archlinux`] }) });
    expect(side).toMatchObject({ device: `rog::wsl:archlinux`, environment: `wsl:archlinux`, screen: undefined, terminal: { ready: true } });
});

it("names a terminal by the computer and where on it the shell runs", () => {
    expect(environmentName(`native`, `Windows`)).toBe(`Windows`);
    expect(terminalTitle(`rog`, `wsl:archlinux`, `Windows`)).toBe(`rog · archlinux`);
    expect(primaryMonitor([{ ...monitor, id: `1`, primary: false }, monitor])?.id).toBe(`0`);
    expect(primaryMonitor([])).toBeUndefined();
});

it("says why a computer with no screen to show has none, when it knows", () => {
    const reason = `this computer has no display, and a virtual desktop needs Xvfb and a desktop session: install xvfb xfce4`;
    const headless = remoteSide(row(), { kind: `answered`, status: status({ monitors: [], screenReason: reason }) });
    expect(headless?.screen).toEqual({ ready: false, reason });
});

it("keeps the screen button while remoted has not run since the sandbox restarted, so no monitors are known yet", () => {
    // The sandbox's daemon forgets what remoted said when it restarts; the terminal's button stays, and so must the screen's.
    const unknown = remoteSide(row(), { kind: `answered`, status: status({ monitors: [] }) });
    expect(unknown?.screen).toEqual({ ready: true });
    const viewOff = remoteSide(row(), { kind: `answered`, status: status({ monitors: [], allow: { view: false, control: false, terminal: true } }) });
    expect(viewOff?.screen).toEqual({ ready: false, reason: `Seeing the screen is off in this computer’s permissions.` });
});
