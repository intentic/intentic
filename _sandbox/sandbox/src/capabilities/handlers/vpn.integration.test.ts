import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import { interfaceName } from "../../vpn/vpn-paths.js";
import type { CapabilityCtx } from "../capability.js";
import { vpnHandler } from "./vpn.js";

// A ctx exposing only what vpnHandler touches, over a fresh temp workspace. HOME is pointed at a temp dir so
// the handler's ~/.intentic-vpn writes land there. Every case here runs with the VPN tooling ABSENT (an empty
// PATH where it matters, and no wg/openconnect on the test host anyway), which is the pre-rebuild state the
// handler must survive: an add has to land in the manifest even when it cannot dial.
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
        // consume the apply frames
    }
};

// The tooling is absent on the test host, so a probe reads "unavailable" → the capability's "needs a rebuild"
// pending state. Runs the assertion with an empty PATH so the result is host-independent either way.
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

    // The conf holds the interface's private key — never group/world-readable.
    expect(readFileSync(confPath(home, "office"), "utf8")).toBe(`${CONF}\n`);
    expect(statSync(confPath(home, "office")).mode & 0o777).toBe(0o600);
    // One shared skill teaches the agent to drive every tunnel through the daemon-backed `vpn` command rather
    // than the underlying clients — that is what keeps agent-initiated and UI-initiated state identical.
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: vpn");
    expect(skill).toContain("vpn connect <name>");
    expect(skill).toContain("vpn disconnect <name>");
    // It must NOT teach the raw clients — those would bypass the daemon and desync the UI.
    expect(skill).not.toContain("wg-quick");
});

test("an id too long to be an interface name still gets a legal, deterministic interface", async () => {
    const longId = "engineering-department-vpn";
    const { ctx, home } = tempCtx();
    await withoutTooling(() => drain(vpnHandler.apply(ctx, longId, wireguard(longId).config)));

    const name = interfaceName(longId);
    expect(name.length).toBeLessThanOrEqual(15);
    expect(name).not.toBe(longId);
    // The conf is named for the interface, because wg-quick derives the interface from the file name.
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
    // The add MUST land: the manifest entry is what puts the fragment into the overlay that installs the client.
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

    // The credential reaches openconnect over stdin at dial time (and never via argv), so the capability's
    // state directory must hold no copy of it — the manifest is the single place it lives.
    const dir = join(home, ".intentic-vpn");
    const spilled = readdirSync(dir).filter((entry) => readFileSync(join(dir, entry), "utf8").includes("s3cret"));
    expect(spilled).toEqual([]);
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: vpn");
});

test("fragment carries every client and both runtime directives, once", async () => {
    const fragment = (await vpnHandler.fragment!(office.config))!;
    expect(fragment).toContain("wireguard-tools");
    expect(fragment).toContain("openconnect");
    expect(fragment).toContain("strongswan");
    // The privileges are the whole reason this fragment is code-authored rather than extension-supplied.
    expect(fragment.split("# intentic:runtime --device=/dev/net/tun").length - 1).toBe(1);
    expect(fragment.split("# intentic:runtime --cap-add=NET_ADMIN").length - 1).toBe(1);
});

test("remove drops the conf but keeps the shared skill while another vpn remains", async () => {
    // Store still holds office + home-lab during removal of office.
    const { ctx, root, home } = tempCtx([office, wireguard("home-lab")]);
    await withoutTooling(async () => {
        await drain(vpnHandler.apply(ctx, "office", office.config));
        await vpnHandler.remove!(ctx, "office", office.config);
    });
    expect(() => readFileSync(confPath(home, "office"), "utf8")).toThrow();
    // home-lab remains → skill stays.
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
