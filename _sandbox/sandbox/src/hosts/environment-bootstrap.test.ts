import { HOST_NATIVE_ENVIRONMENT, type HostFacts } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { bootstrapEnvironments, bootstrapTargets, forgetBootstrap } from "./environment-bootstrap.js";

// ONE INSTALL, WHOLE COMPUTER. Whichever side of a PC the owner ran the one-liner on, the rest of it ends up
// connected — as environments of the same card, so there is no second grant and no second thing to click.

const WINDOWS: HostFacts = {
    os: "Microsoft Windows 11 Home",
    arch: "x64",
    shell: "PowerShell 7",
    home: "C:\\Users\\radar",
    roots: ["C:\\Users\\radar"],
    hostname: "rog",
    wslDistros: ["archlinux", "docker-desktop"],
};
const ARCH: HostFacts = {
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

const services = (over: { enrolled?: (id: string) => boolean; answer?: () => { text: string; refused: boolean } } = {}) => {
    const ran: Ran[] = [];
    const minted: string[] = [];
    const logged: object[] = [];
    return {
        ran,
        minted,
        logged,
        services: {
            config: { sandbox: { publicUrl: "https://work-abc.intentic.dev" } },
            hosts: {
                enrolled: async (id: string) => over.enrolled?.(id) ?? false,
                mintPairing: (id: string) => {
                    minted.push(id);
                    return { token: `iht_for_${id}`, expiresIn: 600 };
                },
            },
            hostHub: {
                mcp: async (id: string, payload: unknown) => {
                    const args = (payload as { params?: { arguments?: { command?: string; in?: unknown } } }).params?.arguments ?? {};
                    ran.push({ id, command: args.command ?? "", in: args.in });
                    const answer = over.answer?.() ?? { text: "Exit code 0 (success).", refused: false };
                    return { result: { content: [{ type: "text", text: answer.text }], isError: answer.refused } };
                },
            },
            logger: { info: (data: object) => void logged.push(data), warn: (data: object) => void logged.push(data) },
        } as unknown as Services,
    };
};

// Fire-and-forget by design, so a test has to let the microtasks it queued run.
const settle = async (): Promise<void> => {
    await vi.waitFor(() => expect(true).toBe(true));
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
    expect(world.ran[0]?.command).toContain("irm https://intentic.dev/device.ps1 | iex");
    expect(world.ran[0]?.command).toContain("$env:PAIR_TOKEN='iht_for_rog'");
});

// The state this runs in most often: everything already connected, on every reconnect of every environment.
test("mints nothing and runs nothing for an environment already connected", async () => {
    const world = services({ enrolled: (id) => id === "rog::wsl:archlinux" });
    bootstrapEnvironments(world.services, "rog", WINDOWS);
    await settle();

    expect(world.minted).toEqual([]);
    expect(world.ran).toEqual([]);
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
