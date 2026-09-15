import {
    type Device,
    DeviceSandboxSchema,
    HOST_NATIVE_ENVIRONMENT,
    hostHoldingPath,
    hostRunningSandbox,
    type HostSummary,
    pathReach,
} from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { machineReach } from "./self-host.js";

// The predicate behind every "run it out there instead of asking" path, tested beside the daemon's reader of it
// (self-host.ts). The browser reads the same function through useHostRunning, so a button and a turn cannot disagree
// about which machine is reachable. It lives in the contract; the directory holding it is at its layout cap.

// Defaults from the schema itself, so a field added to a container row doesn't quietly make these unrepresentative.
const holding = (slugs: readonly string[]): Device["sandboxes"] =>
    slugs.map((slug) =>
        DeviceSandboxSchema.parse({ slug, container: `intentic-sandbox-${slug}`, running: true, image: "ghcr.io/intentic/sandbox:2.3.1" }),
    );

const device = (over: Partial<Device> = {}): Device => ({ key: "ada-laptop", label: "ada-laptop", ...over });

test("names the connected device whose docker reports this sandbox", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, sandboxes: holding(["work-abc", "other"]) })];
    expect(hostRunningSandbox(devices, "work-abc")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "other")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "not-here")).toBeUndefined();
});

// The card setup writes for a new sandbox: it may manage this machine's sandboxes and nothing else, so the machine
// lists its containers and refuses to describe itself. Judging it on the report is what printed a terminal command
// for the one rebuild a fresh sandbox always needs.
test("names a machine that listed its containers while refusing to describe itself", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, gap: "scope-off", sandboxes: holding(["work-abc"]) })];
    expect(hostRunningSandbox(devices, "work-abc")).toBe("ada-laptop");
});

// Each of these is a machine we cannot send a command to, and each looks like a working device in every other way.
test("stays silent for a device that cannot be sent a command", () => {
    const running = holding(["work-abc"]);
    // Enrolled for desktop sync only: it volunteers a report but holds no socket, so there is no `hostId` to call.
    expect(hostRunningSandbox([device({ sandboxes: running, sync: { machine: "ada-laptop", mode: "sync" } })], "work-abc")).toBeUndefined();
    // Connected, asleep.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: false, sandboxes: running })], "work-abc")).toBeUndefined();
    // Connected and up, and its docker really holds nothing.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, sandboxes: [] })], "work-abc")).toBeUndefined();
    // Connected and up, but its docker was never read: no `sandboxes` permission, no docker, or nothing asked yet.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true })], "work-abc")).toBeUndefined();
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, gap: "offline" })], "work-abc")).toBeUndefined();
});

// A caller with no slug must get no answer rather than the first plausible machine: the empty string is what a
// container name with nothing after its prefix leaves behind.
test("refuses to guess a machine for a sandbox it cannot name", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, sandboxes: holding(["work-abc"]) })];
    expect(hostRunningSandbox(devices, undefined)).toBeUndefined();
    expect(hostRunningSandbox(devices, "")).toBeUndefined();
});

// A MACHINE IS ITS CARD; ITS OS INSTALLS ARE ENVIRONMENTS OF IT. What a turn needs told is not a second device but
// which side a call lands in, so the reach is read off the card's own environment list.
test("names the machines with more than one environment, and only those", () => {
    const summary = (id: string, environments: HostSummary["environments"]): HostSummary => ({
        id,
        platform: "windows",
        environments,
        online: environments[0]?.online ?? false,
    });
    const rog = summary("rog", [
        { key: HOST_NATIVE_ENVIRONMENT, online: true, facts: { ...WINDOWS, hostname: "rog" } },
        { key: "wsl:archlinux", online: true, facts: { ...ARCH, hostname: "rog", wsl: { distro: "archlinux" } } },
    ]);
    const omen = summary("omen", [{ key: HOST_NATIVE_ENVIRONMENT, online: true, facts: { ...WINDOWS, hostname: "omen" } }]);
    expect(machineReach([rog, omen], ["rog", "omen"])).toEqual([
        {
            id: "rog",
            environments: [
                { key: HOST_NATIVE_ENVIRONMENT, distro: undefined, shell: WINDOWS.shell, home: WINDOWS.home },
                { key: "wsl:archlinux", distro: "archlinux", shell: ARCH.shell, home: ARCH.home },
            ],
        },
    ]);
    // A machine this turn was not granted is not one to describe.
    expect(machineReach([rog, omen], ["omen"])).toEqual([]);
});

// THE DOOR A CHECKOUT VERB TAKES. One engine serves every door of a PC, so both of these report the same container
// and either may be sent a container verb; a line that `cd`s into a checkout may not, and the first door that "runs
// this sandbox" was the Windows one, which answered a `sh` line with a PowerShell parse error.
const WINDOWS = { os: "Microsoft Windows 11 Home", arch: "x64", shell: "PowerShell 7", home: "C:\\Users\\radar", roots: ["C:\\Users\\radar"] };
const ARCH = { os: "Arch Linux", arch: "x64", shell: "/usr/bin/zsh", home: "/home/radarsu", roots: ["/home/radarsu"] };
const runsWorkAbc = { online: true, sandboxes: holding(["work-abc"]) };
const windowsSide = device({ key: "rog", hostId: "rog", platform: "windows", facts: { ...WINDOWS, hostname: "rog" }, ...runsWorkAbc });
const archSide = device({
    key: "rog-wsl",
    hostId: "rog-wsl",
    platform: "linux",
    facts: { ...ARCH, hostname: "rog", wsl: { distro: "Arch" } },
    ...runsWorkAbc,
});

test("sends a line written for a unix checkout to the distro's door, not the PC's Windows side", () => {
    const rog = [windowsSide, archSide];
    expect(hostRunningSandbox(rog, "work-abc")).toBe("rog");
    expect(hostHoldingPath(rog, "work-abc", "/home/radarsu/intentic/workspace-82789f4106b4/intentic")).toBe("rog-wsl");
    // A `~` path is a unix line's too: the daemon writes it as $HOME, which is the distro's home.
    expect(hostHoldingPath(rog, "work-abc", "~/.intentic/logs/dev-rebuild-work-abc.log")).toBe("rog-wsl");
    // The same question the other way round, for a folder only the Windows side has.
    expect(hostHoldingPath(rog, "work-abc", "C:\\Users\\radar\\intentic")).toBe("rog");
});

// Both distros run sh and both answer for the same containers, so the dialect cannot choose between them; the home
// the checkout sits under can.
test("tells two distros of one PC apart by the home the checkout sits under", () => {
    const ubuntuSide = device({
        key: "rog-wsl-ubuntu",
        hostId: "rog-wsl-ubuntu",
        platform: "linux",
        facts: { ...ARCH, os: "Ubuntu", home: "/home/ada", roots: ["/home/ada"], hostname: "rog", wsl: { distro: "Ubuntu" } },
        ...runsWorkAbc,
    });
    const rog = [windowsSide, ubuntuSide, archSide];
    expect(hostHoldingPath(rog, "work-abc", "/home/radarsu/intentic")).toBe("rog-wsl");
    expect(hostHoldingPath(rog, "work-abc", "/home/ada/intentic")).toBe("rog-wsl-ubuntu");
    // A checkout under nobody's home is still a unix path: the first door that runs sh, rather than none.
    expect(hostHoldingPath(rog, "work-abc", "/srv/intentic")).toBe("rog-wsl-ubuntu");
});

// ONE CONNECTED MACHINE IS ENOUGH. The Windows side of the PC cannot open a distro's path with its own shell, but
// `run_command` takes the crossing as an argument, so the door still reaches it — the owner connected the computer,
// not one of its shells.
test("crosses from the Windows door into the distro that holds the checkout", () => {
    const listing = { ...WINDOWS, hostname: "rog", wslDistros: ["archlinux", "docker-desktop"] };
    const windowsOnly = device({ key: "rog", hostId: "rog", platform: "windows", facts: listing, ...runsWorkAbc });
    expect(hostHoldingPath([windowsOnly], "work-abc", "/home/radarsu/intentic")).toBe("rog");
    expect(pathReach("windows", listing, "/home/radarsu/intentic")).toEqual({ kind: "wsl", distro: "archlinux" });
    // Docker Desktop's own distros are listed by wsl like any other and hold nobody's checkout; counting them would
    // make every Docker Desktop PC look ambiguous.
    expect(pathReach("windows", { ...WINDOWS, wslDistros: ["docker-desktop", "docker-desktop-data"] }, "/home/ada/x")).toEqual({
        kind: "none",
        distros: [],
    });
});

// A door that runs the line itself is one hop fewer and needs no distro guessed at.
test("prefers the distro's own door over crossing from the Windows side", () => {
    const windowsOnly = device({
        key: "rog",
        hostId: "rog",
        platform: "windows",
        facts: { ...WINDOWS, hostname: "rog", wslDistros: ["archlinux"] },
        ...runsWorkAbc,
    });
    expect(hostHoldingPath([windowsOnly, archSide], "work-abc", "/home/radarsu/intentic")).toBe("rog-wsl");
});

test("answers nothing when only the side that cannot open the checkout is connected", () => {
    // A Windows door whose agent never listed any distro: `wslDistros` and `in` shipped together, so silence here is
    // an agent that would reject the crossing rather than a PC with nothing to cross into.
    expect(hostHoldingPath([windowsSide], "work-abc", "/home/radarsu/intentic")).toBeUndefined();
    expect(pathReach("windows", windowsSide.facts, "/home/radarsu/intentic")).toEqual({ kind: "none", distros: [] });
    // Two real distros and no evidence which has the folder: refused, with both named for the reader.
    expect(pathReach("windows", { ...WINDOWS, wslDistros: ["archlinux", "ubuntu"] }, "/home/radarsu/intentic")).toEqual({
        kind: "none",
        distros: ["archlinux", "ubuntu"],
    });
    // No checkout recorded is no question to answer, and a sandbox no door reports has nowhere to send this.
    expect(hostHoldingPath([windowsSide, archSide], "work-abc", undefined)).toBeUndefined();
    expect(hostHoldingPath([windowsSide, archSide], "not-here", "/home/radarsu/intentic")).toBeUndefined();
});

// A door that never said which platform it is: an agent older than `HostFacts`, a card with commands off. Blocking on
// silence would take away the button that works today, so only positive disagreement is read.
test("keeps a door that has not said what it is", () => {
    const quiet = device({ hostId: "ada-laptop", ...runsWorkAbc });
    expect(hostHoldingPath([quiet], "work-abc", "/home/ada/intentic")).toBe("ada-laptop");
    expect(hostHoldingPath([quiet], "work-abc", "C:\\Users\\Ada\\intentic")).toBe("ada-laptop");
});
