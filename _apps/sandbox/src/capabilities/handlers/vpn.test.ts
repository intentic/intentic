import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createTerminalRunner } from "../../terminal/terminal-run.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { vpnHandler } from "./vpn.js";

// A ctx exposing only what vpnHandler touches, over a fresh temp workspace. HOME is pointed at a temp dir so
// the handler's ~/.wireguard writes land there. The terminal runner is the real one in its no-tmux fallback
// (visible:false — commands run as plain bash). All cases keep the tunnel down (enabled "off" / no interface),
// so wg/wg-quick never need to exist — their probe/teardown failures are tolerated by design.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "vpn-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "vpn-cap-home-"));
    process.env.HOME = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
        terminalRun: createTerminalRunner(),
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

const CONF =
    "[Interface]\nPrivateKey = PRIV\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = PUB\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/24";
const office: Capability = { id: "office", kind: "vpn", config: { config: CONF, enabled: "off" } };
const confPath = (home: string, id: string): string => join(home, ".wireguard", `${id}.conf`);
const skillPath = (root: string): string => join(root, ".claude", "skills", "vpn", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply (off) stores a 0600 conf with a trailing newline plus the shared skill; the tunnel stays down", async () => {
    const { ctx, root, home } = tempCtx();
    expect(await vpnHandler.status(ctx, "office", office.config)).toEqual({ state: "inactive" });

    await drain(vpnHandler.apply(ctx, "office", office.config));

    // The conf holds the private key — never group/world-readable.
    expect(readFileSync(confPath(home, "office"), "utf8")).toBe(`${CONF}\n`);
    expect(statSync(confPath(home, "office")).mode & 0o777).toBe(0o600);
    // One shared skill teaches the agent to check and toggle every tunnel.
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: vpn");
    expect(skill).toContain("wg-quick up ~/.wireguard/<name>.conf");
    // Stored but switched off: inactive, not an error.
    expect(await vpnHandler.status(ctx, "office", office.config)).toEqual({ state: "inactive" });
});

test("status reports pending (rebuild required) when enabled but the WireGuard tooling isn't installed", async () => {
    const { ctx } = tempCtx();
    await drain(vpnHandler.apply(ctx, "office", office.config));
    // An empty PATH guarantees wg/wg-quick are absent — the pre-rebuild state, host-independent.
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "vpn-nopath-"));
    try {
        expect(await vpnHandler.status(ctx, "office", { ...office.config, enabled: "on" })).toEqual({ state: "pending", detail: "rebuild required" });
    } finally {
        process.env.PATH = path;
    }
});

test("apply with the connection on but no tooling stores the conf and defers to the rebuild instead of failing", async () => {
    const { ctx, home } = tempCtx();
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "vpn-nopath-"));
    try {
        await drain(vpnHandler.apply(ctx, "office", { ...office.config, enabled: "on" }));
    } finally {
        process.env.PATH = path;
    }
    expect(statSync(confPath(home, "office")).mode & 0o777).toBe(0o600);
});

test("fragment carries the WireGuard install and both runtime directives", () => {
    const fragment = vpnHandler.fragment!(office.config)!;
    expect(fragment).toContain("wireguard-tools");
    expect(fragment).toContain("# intentic:runtime --device=/dev/net/tun");
    expect(fragment).toContain("# intentic:runtime --cap-add=NET_ADMIN");
});

test("remove drops the conf but keeps the shared skill while another vpn remains", async () => {
    const other: Capability = { id: "home-lab", kind: "vpn", config: { config: CONF, enabled: "off" } };
    // Store still holds office + home-lab during removal of office.
    const { ctx, root, home } = tempCtx([office, other]);
    await drain(vpnHandler.apply(ctx, "office", office.config));

    await vpnHandler.remove!(ctx, "office", office.config);
    expect(() => readFileSync(confPath(home, "office"), "utf8")).toThrow();
    // home-lab remains → skill stays.
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: vpn");
});

test("remove deletes the shared skill when the last vpn goes", async () => {
    // Store holds only office during its removal.
    const { ctx, root } = tempCtx([office]);
    await drain(vpnHandler.apply(ctx, "office", office.config));
    await vpnHandler.remove!(ctx, "office", office.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});
