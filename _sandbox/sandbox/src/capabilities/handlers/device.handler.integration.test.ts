import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { HOST_PEER } from "../../hosts/host-peer.js";
import { filePeerStore } from "../../peers/peer-store.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { contributionRegistry } from "../contributions.js";
import { echoConfig, secretField } from "../summary.js";
import { deviceHandler } from "./device.handler.js";

// The real first-party `devices` extension provides each OS pack; the tool surface it wraps is core.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what deviceHandler touches. The machine is never enrolled here, which is the pre-Connect
// state every add starts in: enrolling one needs a real socket from a real device.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "host-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => [] },
        extensionsDir: EXTENSIONS_DIR,
        historyRoot: mkdtempSync(join(tmpdir(), "cap-history-")),
        hosts: { enrolled: async () => false },
        hostHub: { online: () => false },
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- each enrollment rewrites the file whole
        const enrolled = await hosts.enroll(hosts.mintPairing(id).token);
        tokens.set(id, enrolled?.token ?? "");
    }
    const disconnected: string[] = [];
    const ctx = {
        ...tempCtx().ctx,
        hosts,
        hostHub: { online: () => false, disconnect: (id: string) => void disconnected.push(id) },
    } as unknown as CapabilityCtx;
    const ids = async (): Promise<string[]> => (await hosts.list()).map((peer) => peer.id).toSorted();
    return { ctx, hosts, tokens, disconnected, ids };
};

test("removing a device revokes every OS install it holds, and nothing that merely shares a prefix", async () => {
    const { ctx, disconnected, ids } = await pairedMachine();

    await deviceHandler.remove?.(ctx, "rog", laptop.config);

    // The WSL side left behind was a live key no card listed: exactly how rog::wsl and omen::wsl outlived their
    // cards' removal and re-attached, unasked, when a card of the same name came back.
    expect(await ids()).toEqual(["omen::wsl:archlinux", "rogue"]);
    expect(disconnected).toEqual(["rog", "rog::wsl:archlinux"]);
});

test("renaming a device carries every OS install to the new name, each keeping its own key", async () => {
    const { ctx, hosts, tokens, disconnected, ids } = await pairedMachine();

    await deviceHandler.rename.carry?.(ctx, "rog", "desk", laptop.config);

    expect(await ids()).toEqual(["desk", "desk::wsl:archlinux", "omen::wsl:archlinux", "rogue"]);
    // No re-pairing: the distro's own token now answers to the new name.
    expect(await hosts.verify(tokens.get("rog::wsl:archlinux") ?? "")).toEqual({ kind: "enrolled", id: "desk::wsl:archlinux" });
    expect(disconnected).toEqual(["rog", "rog::wsl:archlinux"]);
});
