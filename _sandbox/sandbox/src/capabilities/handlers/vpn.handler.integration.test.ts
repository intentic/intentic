import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { interfaceName } from "../../vpn/vpn-paths.js";
import type { CapabilityCtx } from "../capability.js";
import { vpnHandler } from "./vpn.handler.js";

// Ctx over a fresh temp workspace; HOME is a temp dir too, so ~/.intentic-vpn writes land there. Every test runs with
// the VPN tooling absent, the pre-rebuild state an add must survive.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "vpn-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "vpn-cap-home-"));
    process.env["HOME"] = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

const CONF =
    "[Interface]\nPrivateKey = PRIV\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = PUB\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/24";
const wireguard = (id: string, autoConnect: "on" | "off" = "off"): Capability => ({
    id,
    kind: "vpn",
    config: { provider: "wireguard", config: CONF, autoConnect },
});
const office = wireguard("office");
const confPath = (home: string, id: string): string => join(home, ".intentic-vpn", `${interfaceName(id)}.conf`);
const skillPath = (root: string): string => join(root, ".agents", "skills", "vpn", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
    }
};

// Empty PATH makes the probe read "unavailable" (pending, needs a rebuild), independent of what's actually on the test
// host.
const withoutTooling = async <T>(body: () => Promise<T>): Promise<T> => {
    const path = process.env["PATH"];
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "vpn-nopath-"));
    try {
        return await body();
    } finally {
        process.env["PATH"] = path;
    }
};

test("apply stores a 0600 wireguard conf named for its interface, plus the shared skill", async () => {
    const { ctx, root, home } = tempCtx();
    await withoutTooling(() => drain(vpnHandler.apply(ctx, "office", office.config)));

    // The conf holds the interface's private key: never group/world-readable.
    expect(readFileSync(confPath(home, "office"), "utf8")).toBe(`${CONF}\n`);
    expect(statSync(confPath(home, "office")).mode & 0o777).toBe(0o600);
    // Skill teaches the daemon-backed `vpn` command, not the raw clients, so agent and UI state can't diverge.
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: vpn");
    expect(skill).toContain("vpn connect <name>");
    expect(skill).toContain("vpn disconnect <name>");
    // Raw clients bypass the daemon and desync the UI, so the skill must not mention them.
    expect(skill).not.toContain("wg-quick");
});

test("an id too long to be an interface name still gets a legal, deterministic interface", async () => {
    const longId = "engineering-department-vpn";
    const { ctx, home } = tempCtx();
    await withoutTooling(() => drain(vpnHandler.apply(ctx, longId, wireguard(longId).config)));

    const name = interfaceName(longId);
    expect(name.length).toBeLessThanOrEqual(15);
    expect(name).not.toBe(longId);
    // wg-quick derives the interface name from the conf's file name.
    expect(statSync(confPath(home, longId)).mode & 0o777).toBe(0o600);
    expect(interfaceName(longId)).toBe(name);
});

test("status reports pending (rebuild required) while the VPN tooling is not installed", async () => {
    const { ctx } = tempCtx();
    await withoutTooling(async () => {
        await drain(vpnHandler.apply(ctx, "office", office.config));
        expect(await vpnHandler.status(ctx, "office", office.config)).toEqual({ state: "pending", detail: "rebuild required" });
    });
});

test("apply with auto-connect on but no tooling stores the connection instead of failing", async () => {
    // The add must land: this entry is what puts the fragment into the overlay that installs the client.
    const { ctx, home } = tempCtx();
    const auto = wireguard("office", "on");
    await withoutTooling(() => drain(vpnHandler.apply(ctx, "office", auto.config)));
    expect(statSync(confPath(home, "office")).mode & 0o777).toBe(0o600);
});

test("a fortinet connection's password never reaches disk", async () => {
    const { ctx, root, home } = tempCtx();
    const fortinet: Capability = {
        id: "hq",
        kind: "vpn",
        config: { provider: "fortinet", server: "vpn.example.com", port: 10443, username: "user", password: "s3cret", autoConnect: "off" },
    };
    await withoutTooling(() => drain(vpnHandler.apply(ctx, "hq", fortinet.config)));

    // Password reaches openconnect over stdin at dial time, never argv or disk; the manifest is its only home.
    const dir = join(home, ".intentic-vpn");
    const spilled = readdirSync(dir).filter((entry) => readFileSync(join(dir, entry), "utf8").includes("s3cret"));
    expect(spilled).toEqual([]);
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: vpn");
});

test("fragment carries every client and both runtime directives, once, in two separate blocks", async () => {
    const returned = (await vpnHandler.fragment!(office.config))!;
    // Split is load-bearing: fragments dedupe by exact content, and exit's tun block must byte-match this one.
    const blocks = typeof returned === "string" ? [returned] : [...returned];
    expect(blocks).toHaveLength(2);
    const [tools, privileges] = blocks as [string, string];
    expect(tools).toContain("wireguard-tools");
    expect(tools).toContain("openconnect");
    expect(tools).toContain("strongswan");
    // Clients block asks for nothing privileged; privileges block installs nothing.
    expect(tools).not.toContain("intentic:runtime");
    expect(privileges).not.toContain("apt-get");
    expect(privileges.split("# intentic:runtime --device=/dev/net/tun").length - 1).toBe(1);
    expect(privileges.split("# intentic:runtime --cap-add=NET_ADMIN").length - 1).toBe(1);
});

test("remove drops the conf but keeps the shared skill while another vpn remains", async () => {
    // Store still lists both office and home-lab while office is being removed.
    const { ctx, root, home } = tempCtx([office, wireguard("home-lab")]);
    await withoutTooling(async () => {
        await drain(vpnHandler.apply(ctx, "office", office.config));
        await vpnHandler.remove!(ctx, "office", office.config);
    });
    expect(() => readFileSync(confPath(home, "office"), "utf8")).toThrow();
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: vpn");
});

test("remove deletes the shared skill when the last vpn goes", async () => {
    // Store holds only office during its removal.
    const { ctx, root } = tempCtx([office]);
    await withoutTooling(async () => {
        await drain(vpnHandler.apply(ctx, "office", office.config));
        await vpnHandler.remove!(ctx, "office", office.config);
    });
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});
