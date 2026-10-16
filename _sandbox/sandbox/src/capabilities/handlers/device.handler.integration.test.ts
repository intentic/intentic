import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { stubEnv } from "@intentic/testing/bun";
import type { ExtensionHost } from "../extension-inventory/installed-extensions.js";
import { enrolledFleet, enrollSyncKey } from "../../peers/desktop-sync.js";
import { HOST_PEER } from "../../hosts/host-peer.js";
import { createPeerHub, type PeerClient } from "../../peers/peer-hub.js";
import { filePeerStore } from "../../peers/peer-store.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { contributionRegistry } from "../contributions.js";
import { echoConfig, secretField } from "../summary.js";
import { deviceHandler, refreshDeviceSkill } from "./device.handler.js";

// The real first-party `devices` extension provides each OS pack; the tool surface it wraps is core.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

interface TempCtxOptions {
    // The workspace, to act twice on one skill.
    readonly root?: string;
    readonly cards?: readonly Capability[];
    // What the machine said of itself at its last connect; absent for one that has not connected.
    readonly facts?: object;
}

// A ctx exposing only what deviceHandler touches. The machine is never enrolled here, which is the pre-Connect
// state every add starts in: enrolling one needs a real socket from a real device.
const tempCtx = ({ root = mkdtempSync(join(tmpdir(), "host-cap-")), cards = [], facts }: TempCtxOptions = {}): { ctx: CapabilityCtx; root: string } => {
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => cards },
        extensionsDir: EXTENSIONS_DIR,
        historyRoot: mkdtempSync(join(tmpdir(), "cap-history-")),
        hosts: { enrolled: async () => false },
        hostHub: { online: () => facts !== undefined, state: () => (facts === undefined ? { online: false } : { online: true, facts }) },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR, historyRoot: mkdtempSync(join(tmpdir(), "cap-history-")) },
} as unknown as ExtensionHost;

const laptop: Capability = {
    id: "my-laptop",
    kind: "device",
    config: {
        platform: "windows",
        shell: "on",
        write: "off",
        screen: "on",
        control: "off",
        sandboxes: "off",
        destructive: "off",
        programs: "off",
    },
};
const skillPath = (root: string): string => join(root, ".agents", "skills", "my-laptop", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply installs the contributed OS pack with the core tools note and this instance's name", async () => {
    const { ctx, root } = tempCtx();
    expect(await deviceHandler.status(ctx, "my-laptop", laptop.config)).toEqual({ state: "inactive" });

    await drain(deviceHandler.apply(ctx, "my-laptop", laptop.config));

    const skill = await readWorkspaceFile(skillPath(root));
    // The pack is the OS half (PowerShell here); `${tools}` is the core half, and `${id}` makes the tool names
    // this machine's, so the examples are copy-pasteable rather than illustrative.
    expect(skill).toMatch(/Windows/i);
    expect(skill).toContain("mcp__my-laptop__run_command");
    expect(skill).toContain("name: my-laptop");
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${id}");
    // Added but never connected: the user's next action is running the one-liner over there, and the entry says so.
    expect(await deviceHandler.status(ctx, "my-laptop", laptop.config)).toEqual({
        state: "pending",
        detail: "click Connect and run the one-liner on that device",
    });
});

// (2026-10-13) An Intentic OS box says so in its facts at connect, usually long after its card was applied: its skill
// gains the steward's section then, and only from the side that speaks for the card.
describe("a device on Intentic OS", () => {
    const box: Capability = { id: "my-laptop", kind: "device", config: { ...laptop.config, platform: "linux", sandboxes: "on" } };
    const OS_FACTS = {
        os: "Intentic OS 2026.10.13.0 (kernel 6.11)",
        arch: "x64",
        shell: "/bin/bash",
        home: "/var/home/intentic",
        roots: [],
        intenticOs: { name: "intentic-os", edition: "server", version: "2026.10.13.0", channel: "stable" },
    };

    test("the skill written at apply carries no steward section until the machine says it is one", async () => {
        const { ctx, root } = tempCtx({ cards: [box] });
        await drain(deviceHandler.apply(ctx, "my-laptop", box.config));
        expect(await readWorkspaceFile(skillPath(root))).not.toContain("Intentic OS box");
    });

    test("its connect writes the section in, naming the os tools and the yes a reboot needs, once", async () => {
        const { ctx, root } = tempCtx({ cards: [box] });
        const online = tempCtx({ root, cards: [box], facts: OS_FACTS }).ctx;
        await drain(deviceHandler.apply(ctx, "my-laptop", box.config));
        expect(await refreshDeviceSkill(online, "my-laptop")).toBe(true);
        const skill = await readWorkspaceFile(skillPath(root));
        expect(skill).toContain("## This device is an Intentic OS box, and you may be its steward");
        expect(skill).toContain("mcp__my-laptop__os_status");
        expect(skill).toContain("Never ask for\n   the Docker socket");
        expect(skill).toContain("only after the owner says yes in chat");
        // The rest of the note is all still there, around it.
        expect(skill).toContain("mcp__my-laptop__run_command");
        expect(skill).toContain("## Using a website");
        expect(skill).not.toContain("${id}");
        // The same facts again change nothing, so a reconnect does not rewrite the file.
        expect(await refreshDeviceSkill(online, "my-laptop")).toBe(false);
        // An apply while it is connected keeps the section.
        await drain(deviceHandler.apply(online, "my-laptop", box.config));
        expect(await readWorkspaceFile(skillPath(root))).toContain("Intentic OS box");
    });

    test("a card never applied, another environment's connection and an ordinary machine leave the skill as it is", async () => {
        const { ctx, root } = tempCtx({ cards: [box] });
        const online = tempCtx({ root, cards: [box], facts: OS_FACTS }).ctx;
        expect(await refreshDeviceSkill(online, "my-laptop")).toBe(false);
        expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
        await drain(deviceHandler.apply(ctx, "my-laptop", box.config));
        expect(await refreshDeviceSkill(online, "my-laptop::wsl:archlinux")).toBe(false);
        expect(await refreshDeviceSkill(tempCtx({ root, cards: [box], facts: { ...OS_FACTS, intenticOs: undefined } }).ctx, "my-laptop")).toBe(false);
        expect(await refreshDeviceSkill(tempCtx({ root, cards: [], facts: OS_FACTS }).ctx, "my-laptop")).toBe(false);
        expect(await readWorkspaceFile(skillPath(root))).not.toContain("Intentic OS box");
    });
});

test("an OS with no installed pack is refused rather than writing an empty skill", async () => {
    const { ctx, root } = tempCtx();
    await expect(drain(deviceHandler.apply(ctx, "my-laptop", { ...laptop.config, platform: "plan9" }))).rejects.toThrow(/plan9/);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});

test("every contributed OS pack carries both halves' placeholders", async () => {
    const registry = await contributionRegistry(host);
    const packs = [...registry.values()].filter((entry) => entry.spec.kind === "device");
    expect(packs.map((entry) => entry.spec.id).toSorted()).toEqual(["linux", "windows"]);
});

test("echoConfig renders the grant back and host holds no manifest secret", () => {
    // Every field is a permission and none is a credential: the enrollment token lives on /history, so rotating
    // it is re-running the installer, not an edit in /secrets.
    expect(echoConfig(laptop, new Map())).toEqual({
        platform: "windows",
        shell: "on",
        write: "off",
        screen: "on",
        control: "off",
        sandboxes: "off",
        destructive: "off",
        programs: "off",
    });
    expect(secretField(laptop, new Map())).toBeUndefined();
});

// A machine with its Windows side and a WSL distro paired, beside two enrollments that are NOT its: a card whose
// name merely starts the same, and another machine's distro. Real enrollment store on a temp /history; a hub that
// records which sockets it was told to cut.
const pairedMachine = async () => {
    const hosts = filePeerStore(mkdtempSync(join(tmpdir(), "cap-history-")), HOST_PEER.store);
    const tokens = new Map<string, string>();
    for (const id of ["rog", "rog::wsl:archlinux", "rogue", "omen::wsl:archlinux"]) {
        // each enrollment rewrites the file whole
        const enrolled = await hosts.enroll(hosts.mintPairing(id).token);
        tokens.set(id, enrolled?.token ?? "");
    }
    // A real hub, with the Windows side and its distro holding a socket each: what a rename must not cut.
    const hub = createPeerHub<PeerClient<unknown, unknown>, { version: string }, unknown, unknown>(HOST_PEER.hub, { warn: () => {} });
    const closed: string[] = [];
    for (const id of ["rog", "rog::wsl:archlinux"]) {
        const client: PeerClient<unknown, unknown> = { describe: async () => ({}), ping: async () => ({}), mcp: async () => ({ from: id }) };
        hub.attach(id, { client, close: (_code, reason) => void closed.push(`${id}: ${reason}`), announced: { version: "1.0.0" } });
    }
    const disconnected: string[] = [];
    const hostHub = {
        online: hub.online,
        rekey: hub.rekey,
        disconnect: (id: string, reason: string) => {
            disconnected.push(id);
            hub.disconnect(id, reason);
        },
    };
    const ctx = { ...tempCtx().ctx, hosts, hostHub } as unknown as CapabilityCtx;
    const ids = async (): Promise<string[]> => (await hosts.list()).map((peer) => peer.id).toSorted();
    return { ctx, hosts, hub, tokens, closed, disconnected, ids };
};

test("removing a device revokes every OS install it holds, and nothing that merely shares a prefix", async () => {
    const { ctx, disconnected, ids } = await pairedMachine();

    await deviceHandler.remove?.(ctx, "rog", laptop.config);

    // The WSL side left behind was a live key no card listed: exactly how rog::wsl and omen::wsl outlived their
    // cards' removal and re-attached, unasked, when a card of the same name came back.
    expect(await ids()).toEqual(["omen::wsl:archlinux", "rogue"]);
    expect(disconnected).toEqual(["rog", "rog::wsl:archlinux"]);
});

test("renaming a device carries every OS install to the new name, each keeping its own key and its live socket", async () => {
    const { ctx, hosts, hub, tokens, closed, disconnected, ids } = await pairedMachine();

    await deviceHandler.rename.carry?.(ctx, "rog", "desk", laptop.config);

    expect(await ids()).toEqual(["desk", "desk::wsl:archlinux", "omen::wsl:archlinux", "rogue"]);
    // No re-pairing: the distro's own token now answers to the new name.
    expect(await hosts.verify(tokens.get("rog::wsl:archlinux") ?? "")).toEqual({ kind: "enrolled", id: "desk::wsl:archlinux", card: "desk" });
    // The name is a label: nothing was cut, and each side answers under its new id through the socket it already held.
    expect(disconnected).toEqual([]);
    expect(closed).toEqual([]);
    expect(hub.connected().toSorted()).toEqual(["desk", "desk::wsl:archlinux"]);
    expect(await hub.mcp("desk::wsl:archlinux", {})).toEqual({ from: "rog::wsl:archlinux" });
    for (const id of hub.connected()) {
        hub.disconnect(id, "test over");
    }
});

// (2026-10-05) A device card's computers also sync with this sandbox through a key of their own, which removing the card
// used to leave authorized under no card at all. The card's enrollments say which computers and environments it held;
// their sync keys go with it, and nobody else's.
test("removing a card revokes the desktop-sync keys of the computers it held, and no other's", async () => {
    stubEnv("HOME", mkdtempSync(join(tmpdir(), "card-sync-home-")));
    const { ctx: base } = tempCtx();
    const historyRoot = base.historyRoot;
    const held = [
        { id: "rog", card: "rog", machineId: "m-rog-0001", environment: "native" },
        { id: "rog::wsl:Ubuntu", card: "rog", machineId: "m-rog-0001", environment: "wsl:Ubuntu" },
        { id: "omen", card: "omen", machineId: "m-omen-0001", environment: "native" },
    ];
    const cut: string[] = [];
    const ctx = {
        ...base,
        hosts: {
            list: async () => held,
            revokeCard: async (card: string) => held.filter((entry) => entry.card === card).map((entry) => entry.id),
        },
        hostHub: { disconnect: (id: string) => void cut.push(id) },
        logger: { info: () => undefined, warn: () => undefined },
    } as unknown as CapabilityCtx;
    await enrollSyncKey({
        historyRoot,
        key: "ssh-ed25519 AAAArog ROG",
        mode: "sync",
        takeover: false,
        machineId: "m-rog-0001",
        environment: "native",
    });
    await enrollSyncKey({
        historyRoot,
        key: "ssh-ed25519 AAAArogwsl ROG",
        mode: "mirror",
        takeover: false,
        machineId: "m-rog-0001",
        environment: "wsl:Ubuntu",
    });
    await enrollSyncKey({
        historyRoot,
        key: "ssh-ed25519 AAAAomen omen",
        mode: "mirror",
        takeover: false,
        machineId: "m-omen-0001",
        environment: "native",
    });

    await deviceHandler.remove?.(ctx, "rog", {});

    expect(cut).toEqual(["rog", "rog::wsl:Ubuntu"]);
    expect((await enrolledFleet(historyRoot)).machines.map((row) => row.machine)).toEqual(["omen"]);
});
