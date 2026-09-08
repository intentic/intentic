import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, ExitConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { exitHandler } from "./exit.handler.js";
import { vpnHandler } from "./vpn.handler.js";

// Ctx over a fresh temp workspace; HOME is a temp dir too, so ~/.intentic-exit writes land there. Every test runs with
// the exit tooling absent, the pre-rebuild state an add must survive.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "exit-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "exit-cap-home-"));
    process.env["HOME"] = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

// Named `geo`, not `exit`: a shell builtin swallows that name, so the skill takes the CLI's real name.
const skillPath = (root: string): string => join(root, ".agents", "skills", "geo", "SKILL.md");

const tor = (autoStart: "on" | "off" = "off", country?: string): ExitConfig =>
    ({ provider: "tor", autoStart, ...(country === undefined ? {} : { country }) }) as ExitConfig;
const vpngate: ExitConfig = { provider: "vpngate", autoStart: "off" } as ExitConfig;
const wireguard: ExitConfig = {
    provider: "wireguard",
    autoStart: "off",
    config: "[Interface]\nPrivateKey = X\n\n[Peer]\nEndpoint = de-ber-wg-001.relays.mullvad.net:51820",
} as ExitConfig;

const drain = async (gen: AsyncGenerator<unknown>): Promise<string[]> => {
    const lines: string[] = [];
    for await (const line of gen) {
        const message = (line as { message?: unknown }).message;
        if (typeof message === "string") {
            lines.push(message);
        }
    }
    return lines;
};

const fragments = async (config: ExitConfig): Promise<string[]> => {
    const result = await exitHandler.fragment?.(config);
    return result === undefined ? [] : typeof result === "string" ? [result] : [...result];
};

// secret/echo take the connector registry as a second arg; no exit provider consults it, so empty is honest.
const NO_CONNECTORS = new Map();

test("a tor exit asks for NO container privileges: that is what makes it the cheap default", async () => {
    // Tor publishes its own SOCKS port; it needs neither a tun device nor NET_ADMIN.
    const blocks = await fragments(tor());
    expect(blocks.join("\n")).toContain("install -y --no-install-recommends tor");
    expect(blocks.join("\n")).not.toContain("intentic:runtime");
});

test("the tunnel-building providers ask for the tun privilege, and for exactly the same block the vpn kind uses", async () => {
    // Fragments dedupe by exact content when composed; a byte of drift here doubles the --device flag.
    const vpnBlocks = (await vpnHandler.fragment?.({ provider: "wireguard", config: "x", autoConnect: "off" })) ?? [];
    const shared = (typeof vpnBlocks === "string" ? [vpnBlocks] : [...vpnBlocks]).find((block) => block.includes("intentic:runtime"));
    for (const config of [vpngate, wireguard]) {
        const privileged = (await fragments(config)).find((block) => block.includes("intentic:runtime"));
        expect(privileged).toBe(shared);
    }
    expect(shared?.match(/# intentic:runtime --device=\/dev\/net\/tun/g)).toHaveLength(1);
    expect(shared?.match(/# intentic:runtime --cap-add=NET_ADMIN/g)).toHaveLength(1);
});

test("each provider installs only its own client", async () => {
    // Strips comment lines first: matching prose would pass even if the fragment no longer installs the package.
    const installs = async (config: ExitConfig): Promise<string> =>
        (await fragments(config))
            .join("\n")
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n");
    expect(await installs(vpngate)).toContain("openvpn");
    expect(await installs(vpngate)).not.toMatch(/\btor\b/);
    expect(await installs(wireguard)).toContain("wireguard-tools");
    // No openresolv: a pasted conf's DNS= line is stripped so the tunnel can't rewrite the container's resolv.conf.
    expect(await installs(wireguard)).not.toContain("openresolv");
    expect(await installs(tor())).not.toContain("openvpn");
});

test("adding an exit lands in the manifest and writes the shared skill, even with no client installed", async () => {
    const { ctx, root } = tempCtx();
    const lines = await drain(exitHandler.apply(ctx, "berlin", tor("off", "DE")));
    expect(lines.join(" ")).toMatch(/Stored berlin/);
    const skill = readFileSync(skillPath(root), "utf8");
    expect(skill).toContain("name: geo");
    expect(skill).toMatch(/`exit` is a shell builtin/);
    expect(skill).toMatch(/proxied by default/i);
    expect(skill).toMatch(/Tor exits are blocked by a lot of the web/);
    expect(skill).toMatch(/datacenter addresses/);
});

test("only the bring-your-own arm carries a credential", () => {
    // tor/vpngate have no account; marking them secret-holding would misdescribe an empty inventory row.
    expect(exitHandler.secret?.(tor(), NO_CONNECTORS)).toBeUndefined();
    expect(exitHandler.secret?.(vpngate, NO_CONNECTORS)).toBeUndefined();
    expect(exitHandler.secret?.(wireguard, NO_CONNECTORS)).toBe("config");
});

test("the echo is an allowlist, so pasted keys can never reach the browser", () => {
    // A forgotten field is vaulted, not leaked; that fails validation on next read for a field like `country`.
    const echoed = exitHandler.echo?.(wireguard, NO_CONNECTORS) ?? {};
    expect(echoed).toEqual({ provider: "wireguard", autoStart: "off" });
    expect(JSON.stringify(echoed)).not.toContain("PrivateKey");
    expect(exitHandler.echo?.(tor("on", "DE"), NO_CONNECTORS)).toEqual({ provider: "tor", autoStart: "on", country: "DE" });
});

test("an exit with no client installed reads as needing a rebuild, not as broken", async () => {
    const { ctx } = tempCtx();
    await drain(exitHandler.apply(ctx, "berlin", tor()));
    expect(await exitHandler.status(ctx, "berlin", tor())).toEqual({ state: "pending", detail: "rebuild required" });
});

test("an auto-start exit says what it is waiting for instead of failing the add", async () => {
    // This very add composes the overlay that installs the client; failing here would block the add entirely.
    const { ctx } = tempCtx();
    const lines = await drain(exitHandler.apply(ctx, "berlin", tor("on")));
    expect(lines.join(" ")).toMatch(/doesn't carry tor yet/);
    expect(lines.join(" ")).toMatch(/Rebuild it/);
});

test("removing the last exit takes the shared skill with it, and an earlier one does not", async () => {
    const { ctx, root } = tempCtx();
    await drain(exitHandler.apply(ctx, "berlin", tor()));
    expect(() => readFileSync(skillPath(root), "utf8")).not.toThrow();

    // The route removes the manifest entry after the handler; the list here still holds the one being removed.
    const withTwo = tempCtx([
        { id: "berlin", kind: "exit", config: tor() },
        { id: "osaka", kind: "exit", config: vpngate },
    ]);
    await drain(exitHandler.apply(withTwo.ctx, "berlin", tor()));
    await exitHandler.remove?.(withTwo.ctx, "berlin", tor());
    expect(() => readFileSync(skillPath(withTwo.root), "utf8")).not.toThrow();

    await exitHandler.remove?.(ctx, "berlin", tor());
    expect(() => readFileSync(skillPath(root), "utf8")).toThrow();
});
