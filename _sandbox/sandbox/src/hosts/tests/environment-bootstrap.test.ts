import { HOST_NATIVE_ENVIRONMENT, type DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { bootstrapEnvironments, bootstrapTargets, forgetBootstrap, reviveSilentWindows, silenceOf } from "../environment-bootstrap.js";

// ONE INSTALL, WHOLE COMPUTER. Whichever side of a PC the owner ran the one-liner on, the rest of it ends up
// connected — as environments of the same card, so there is no second grant and no second thing to click.

const WINDOWS: DeviceFacts = {
    os: "Microsoft Windows 11 Home",
    arch: "x64",
    shell: "PowerShell 7",
    home: "C:\\Users\\radar",
    roots: ["C:\\Users\\radar"],
    hostname: "rog",
    wslDistros: ["archlinux", "docker-desktop"],
};
const ARCH: DeviceFacts = {
    os: "Arch Linux",
    arch: "x64",
    shell: "/usr/bin/zsh",
    home: "/home/radarsu",
    roots: ["/home/radarsu"],
    hostname: "rog",
    wsl: { distro: "archlinux" },
};

// What the machine was asked to run, and where it was asked to run it.
interface Ran {
    readonly id: string;
    readonly command: string;
    readonly in: unknown;
}

const services = (
    over: {
        enrolled?: (id: string) => boolean;
        answer?: () => { text: string; refused: boolean };
        publicUrl?: string;
        // Which connections hold a socket now, and when each other one last did (absent: not since this daemon started).
        online?: readonly string[];
        lastSeen?: Readonly<Record<string, number>>;
    } = {},
) => {
    const ran: Ran[] = [];
    const minted: string[] = [];
    // What each short code was minted to stand for, in mint order; the code is its index.
    const codes: unknown[] = [];
    const logged: object[] = [];
    // The level each line was written at, beside it; the lines themselves stay in `logged`, their sentences in `said`.
    const levels: string[] = [];
    const said: string[] = [];
    return {
        levels,
        said,
        ran,
        minted,
        codes,
        logged,
        services: {
            config: { sandbox: { publicUrl: over.publicUrl ?? "https://work-abc.intentic.dev" } },
            redeemCodes: {
                mint: (grant: unknown) => {
                    codes.push(grant);
                    return `CODE000${codes.length}`;
                },
            },
            hosts: {
                enrolled: async (id: string) => over.enrolled?.(id) ?? false,
                // Which card and environment the connection that came up is: its enrollment's record says.
                list: async () => [
                    { id: "rog", card: "rog", environment: HOST_NATIVE_ENVIRONMENT, machineId: "card:rog" },
                    { id: "rog::wsl:archlinux", card: "rog", environment: "wsl:archlinux", machineId: "card:rog" },
                ],
                mintPairing: (id: string) => {
                    minted.push(id);
                    return { token: `iht_for_${id}`, expiresIn: 600 };
                },
            },
            hostHub: {
                connected: () => over.online ?? [],
                online: (id: string) => (over.online ?? []).includes(id),
                state: (id: string) => ({
                    online: (over.online ?? []).includes(id),
                    lastSeen: over.lastSeen?.[id],
                    facts: id === "rog" ? WINDOWS : ARCH,
                }),
                mcp: async (id: string, payload: unknown) => {
                    const args = (payload as { params?: { arguments?: { command?: string; in?: unknown } } }).params?.arguments ?? {};
                    ran.push({ id, command: args.command ?? "", in: args.in });
                    const answer = over.answer?.() ?? { text: "Exit code 0 (success).", refused: false };
                    return { result: { content: [{ type: "text", text: answer.text }], isError: answer.refused } };
                },
            },
            logger: Object.fromEntries(
                ["debug", "info", "warn"].map((level) => [
                    level,
                    (data: object, message: string) => {
                        levels.push(level);
                        logged.push(data);
                        said.push(message);
                    },
                ]),
            ),
        } as unknown as Services,
    };
};

// Fire-and-forget by design, so a test has to let the microtasks it queued run.
const settle = async (): Promise<void> => {
    await waitFor(() => expect(true).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => forgetBootstrap());

test("reads the rest of the computer off the side that connected", () => {
    // Docker Desktop's own distros are listed by wsl like any other and hold nobody's agent.
    expect(bootstrapTargets(HOST_NATIVE_ENVIRONMENT, WINDOWS)).toEqual(["wsl:archlinux"]);
    // From inside a distro there is exactly one sibling: the Windows side it runs on.
    expect(bootstrapTargets("wsl:archlinux", ARCH)).toEqual([HOST_NATIVE_ENVIRONMENT]);
    // A machine with no WSL at all — a Mac, a Linux box — has nothing to connect beyond itself.
    expect(bootstrapTargets(HOST_NATIVE_ENVIRONMENT, { ...WINDOWS, wslDistros: undefined })).toEqual([]);
});

test("installs the agent in the distro from the Windows side, with a token minted for that connection", async () => {
    const world = services();
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();

    expect(world.minted).toEqual(["rog::wsl:archlinux"]);
    expect(world.ran).toHaveLength(1);
    // Sent through the door that IS connected, carried into the one that is not.
    expect(world.ran[0]?.id).toBe("rog");
    expect(world.ran[0]?.in).toBe("wsl:archlinux");
    // The command carries a single-use code standing for that token, never the token itself.
    expect(world.ran[0]?.command).toBe("curl -fsSL https://intentic.dev/device/work-abc.intentic.dev/CODE0001 | sh");
    expect(world.codes).toEqual([{ kind: "device", pairToken: "iht_for_rog::wsl:archlinux" }]);
});

// Local dev: a sandbox on localhost has no address a one-liner could carry, so the token rides as environment.
test("keeps the token in environment variables for a sandbox reached on localhost", async () => {
    const world = services({ publicUrl: "https://localhost:8788" });
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();

    expect(world.ran[0]?.command).toContain("intentic.dev/device");
    expect(world.ran[0]?.command).toContain("PAIR_TOKEN='iht_for_rog::wsl:archlinux'");
});

test("installs the agent on the Windows side from inside a distro, in PowerShell's dialect", async () => {
    const world = services();
    bootstrapEnvironments(world.services, "rog::wsl:archlinux", ARCH);
    await settle();

    expect(world.minted).toEqual(["rog"]);
    expect(world.ran[0]?.id).toBe("rog::wsl:archlinux");
    expect(world.ran[0]?.in).toBe("windows");
    expect(world.ran[0]?.command).toBe(
        "irm https://intentic.dev/device/work-abc.intentic.dev/CODE0001 | iex; $ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }",
    );
});

// The state this runs in most often: everything already connected, on every reconnect of every environment.
test("mints nothing and runs nothing for an environment already connected", async () => {
    const world = services({ enrolled: (id) => id === "rog::wsl:archlinux" });
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();

    expect(world.minted).toEqual([]);
    expect(world.ran).toEqual([]);
    // Nothing happened, so nothing is said above a trace: this line was a third of the info a day used to hold.
    expect(world.levels).toEqual(["debug"]);
});

// A laptop reconnects whenever it wakes. A distro that cannot take an agent must cost one attempt, not one per wake.
test("does not try the same environment again on the next connect", async () => {
    const world = services({ answer: () => ({ text: "curl: command not found", refused: false }) });
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();

    expect(world.ran).toHaveLength(1);
    // Clearing the cooldown is what the distro's own Connect button does.
    forgetBootstrap("rog::wsl:archlinux");
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();
    expect(world.ran).toHaveLength(2);
});

// The owner's switches are the floor: commands off means no bootstrap, reported rather than retried into a loop.
test("reports a device that refuses commands instead of failing the connection", async () => {
    const world = services({ answer: () => ({ text: 'Refused: "Run commands" is switched off for this device.', refused: true }) });
    expect(() => bootstrapEnvironments(world.services, "rog", WINDOWS)).not.toThrow();
    await settle();
    expect(JSON.stringify(world.logged)).toContain("Run commands");
});

// Nothing to dial means nothing to enroll against; the sandbox says so rather than minting a credential nobody can spend.
test("does not mint a pairing for a sandbox with no public address", async () => {
    const world = services();
    const offline = { ...world.services, config: { sandbox: { publicUrl: "" } } } as unknown as Services;
    bootstrapEnvironments(offline, "rog", WINDOWS);
    await settle();
    expect(world.minted).toEqual([]);
    expect(world.ran).toEqual([]);
});

// REVIVING A WINDOWS SIDE FROM ITS DISTRO (2026-10-15). rog's Windows agent was uninstalled while its WSL agent stayed
// connected, and nothing put it back for two days because the Windows side was still enrolled.
const MINUTE = 60_000;

test("puts a Windows side silent for a while back through its distro, with the install it would get as a new one", async () => {
    const world = services({ enrolled: () => true, online: ["rog::wsl:archlinux"], lastSeen: { rog: Date.now() - 37 * MINUTE } });
    bootstrapEnvironments(world.services, "rog::wsl:archlinux", ARCH);
    await settle();

    expect(world.minted).toEqual(["rog"]);
    expect(world.ran).toEqual([
        {
            id: "rog::wsl:archlinux",
            in: "windows",
            command:
                "irm https://intentic.dev/device/work-abc.intentic.dev/CODE0001 | iex; $ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }",
        },
    ]);
    expect(world.said).toEqual(["hosts: reconnecting the Windows side of rog through archlinux (silent 37 min): Exit code 0 (success)."]);
    expect(world.levels).toEqual(["info"]);
});

// A Windows agent redials by itself after this daemon restarts or after its own update: it gets the time to.
test("leaves a Windows side alone while it holds its socket, or has only just lost it", async () => {
    const live = services({ enrolled: () => true, online: ["rog", "rog::wsl:archlinux"] });
    bootstrapEnvironments(live.services, "rog::wsl:archlinux", ARCH);
    await settle();
    expect(live.ran).toEqual([]);

    const recent = services({ enrolled: () => true, online: ["rog::wsl:archlinux"], lastSeen: { rog: Date.now() - 3 * MINUTE } });
    bootstrapEnvironments(recent.services, "rog::wsl:archlinux", ARCH);
    await settle();
    expect(recent.ran).toEqual([]);
    // Nothing ran, so nothing holds the next look back: the clock's next pass may still find it silent long enough.
    const later = services({ enrolled: () => true, online: ["rog::wsl:archlinux"], lastSeen: { rog: Date.now() - 12 * MINUTE } });
    await reviveSilentWindows(later.services);
    await settle();
    expect(later.ran).toHaveLength(1);
});

// A stopped test distro must stay stopped: only a distro brings back Windows, never the other way round.
test("never brings a distro back from the Windows side", async () => {
    const world = services({ enrolled: () => true, online: ["rog"], lastSeen: { "rog::wsl:archlinux": Date.now() - 600 * MINUTE } });
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();
    expect(world.minted).toEqual([]);
    expect(world.ran).toEqual([]);
});

// The Windows side can drop while the distro stays connected, which no connect says: the clock looks for it.
test("looks for a silent Windows side on a clock while the distro stays connected, and only ever revives from there", async () => {
    const world = services({ enrolled: () => true, online: ["rog::wsl:archlinux"], lastSeen: { rog: Date.now() - 40 * MINUTE } });
    await reviveSilentWindows(world.services);
    await settle();
    expect(world.ran.map((run) => [run.id, run.in])).toEqual([["rog::wsl:archlinux", "windows"]]);
    // Within the half hour after that attempt the clock tries nothing more, however often it looks.
    await reviveSilentWindows(world.services);
    await settle();
    expect(world.ran).toHaveLength(1);

    // A Windows side with no enrollment (never paired, or a key the owner revoked) is the connect's to install, not the
    // clock's: a revoke must not be undone behind the owner's back minutes later.
    forgetBootstrap();
    const revoked = services({ enrolled: (id) => id !== "rog", online: ["rog::wsl:archlinux"] });
    await reviveSilentWindows(revoked.services);
    await settle();
    expect(revoked.minted).toEqual([]);
});

// The owner's switches are the floor: a device refusing commands is said once, then quietly, and never retried hot.
test("says a refused revive once, and does not retry it on the next look", async () => {
    const refusing = { text: 'Refused: "Run commands" is switched off for this device.', refused: true };
    const world = services({ enrolled: () => true, online: ["rog::wsl:archlinux"], lastSeen: { rog: Date.now() - 45 * MINUTE }, answer: () => refusing });
    await reviveSilentWindows(world.services);
    await settle();
    await reviveSilentWindows(world.services);
    await settle();
    expect(world.ran).toHaveLength(1);
    expect(world.levels).toEqual(["info"]);
    expect(world.said[0]).toContain('refused by that device: Refused: "Run commands" is switched off');
    // Half an hour on, the same refusal is tried again and folded into the next hourly line rather than said again.
    forgetBootstrap();
    await reviveSilentWindows(world.services);
    await settle();
    expect(world.ran).toHaveLength(2);
    expect(world.levels).toEqual(["info", "debug"]);
});

test("counts a side that has not connected since this daemon started as silent from the start", () => {
    expect(silenceOf({ online: true }, 1_000_000, 0)).toBeUndefined();
    expect(silenceOf({ online: false, lastSeen: 400_000 }, 1_000_000, 0)).toBe(600_000);
    expect(silenceOf({ online: false }, 1_000_000, 100_000)).toBe(900_000);
});
