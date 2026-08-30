import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, ExitConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { exitHandler } from "./exit.js";
import { vpnHandler } from "./vpn.js";

/* A ctx exposing only what exitHandler touches, over a fresh temp workspace. HOME is pointed at a temp dir so
 * the handler's ~/.intentic-exit writes land there. Every case runs with the exit tooling ABSENT (no tor or
 * openvpn on the test host), which is the pre-rebuild state the handler must survive: an add has to land in
 * the manifest even when nothing can be started, because the add is what puts the fragment into the overlay
 * that installs the client in the first place. */
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

// The skill is `geo`, not `exit`: the CLI could not be called `exit` (a shell builtin swallows it), and the
// skill is named for the command it teaches.
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

// The handler's secret/echo take the connector registry as their second argument; no exit provider consults it
// (there are no contributed exit cards), so an empty map is the honest stand-in.
const NO_CONNECTORS = new Map();

test("a tor exit asks for NO container privileges: that is what makes it the cheap default", async () => {
    /* The most consequential assertion in this file. Tor publishes its own SOCKS port, so it needs neither a
     * tun device nor NET_ADMIN, and charging every tor user a privilege they never use would be exactly the
     * quiet over-ask a capability card exists to prevent. If this ever starts failing, the card is disclosing
     * a privilege the provider does not need. */
    const blocks = await fragments(tor());
    expect(blocks.join("\n")).toContain("install -y --no-install-recommends tor");
    expect(blocks.join("\n")).not.toContain("intentic:runtime");
});

test("the tunnel-building providers ask for the tun privilege, and for exactly the same block the vpn kind uses", async () => {
    /* Fragments are deduped by EXACT CONTENT when the overlay is composed. A vpn and an exit in one sandbox is
     * the expected combination, not an exotic one, so if these two blocks ever differ by a byte the composed
     * overlay keeps both and the recreate hands `docker run` the same --device twice. */
    const vpnBlocks = (await vpnHandler.fragment?.({ provider: "wireguard", config: "x", autoConnect: "off" })) ?? [];
    const shared = (typeof vpnBlocks === "string" ? [vpnBlocks] : [...vpnBlocks]).find((block) => block.includes("intentic:runtime"));
    for (const config of [vpngate, wireguard]) {
        const privileged = (await fragments(config)).find((block) => block.includes("intentic:runtime"));
        expect(privileged).toBe(shared);
    }
    // And the directives are each present exactly once inside that one block.
    expect(shared?.match(/# intentic:runtime --device=\/dev\/net\/tun/g)).toHaveLength(1);
    expect(shared?.match(/# intentic:runtime --cap-add=NET_ADMIN/g)).toHaveLength(1);
});

test("each provider installs only its own client", async () => {
    // The INSTALL lines, not the prose around them: the fragments explain themselves in comments, and matching
    // those would pass on a fragment that documents a package it no longer installs.
    const installs = async (config: ExitConfig): Promise<string> =>
        (await fragments(config))
            .join("\n")
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n");
    expect(await installs(vpngate)).toContain("openvpn");
    expect(await installs(vpngate)).not.toMatch(/\btor\b/);
    expect(await installs(wireguard)).toContain("wireguard-tools");
    // Deliberately NOT openresolv: a pasted conf's DNS= line is stripped before the tunnel comes up, because
    // applying it would rewrite /etc/resolv.conf for the whole container.
    expect(await installs(wireguard)).not.toContain("openresolv");
    expect(await installs(tor())).not.toContain("openvpn");
});

test("adding an exit lands in the manifest and writes the shared skill, even with no client installed", async () => {
    const { ctx, root } = tempCtx();
    const lines = await drain(exitHandler.apply(ctx, "berlin", tor("off", "DE")));
    expect(lines.join(" ")).toMatch(/Stored berlin/);
    const skill = readFileSync(skillPath(root), "utf8");
    expect(skill).toContain("name: geo");
    // The collision that forced the rename is stated in the skill itself, or an agent types `exit list` once.
    expect(skill).toMatch(/`exit` is a shell builtin/);
    // The three things an agent gets wrong without being told, all in the skill it is handed.
    expect(skill).toContain("Nothing is proxied by default");
    expect(skill).toMatch(/Tor exits are blocked by a lot of the web/);
    expect(skill).toMatch(/datacenter addresses/);
});

test("only the bring-your-own arm carries a credential", () => {
    // tor and vpngate have no account at all, which is most of the reason they are here. Marking them as
    // holding a secret would put an empty row in the /secrets inventory and misdescribe the card.
    expect(exitHandler.secret?.(tor(), NO_CONNECTORS)).toBeUndefined();
    expect(exitHandler.secret?.(vpngate, NO_CONNECTORS)).toBeUndefined();
    expect(exitHandler.secret?.(wireguard, NO_CONNECTORS)).toBe("config");
});

test("the echo is an allowlist, so pasted keys can never reach the browser", () => {
    /* Not a spread of config. The complement of this echo is what gets vaulted, so a field forgotten here is
     * replaced in the manifest by the vault marker: for `country` (a two-letter code) that marker fails the
     * schema on the next read and takes the whole entry out of the manifest, which is a much louder failure
     * than a leaked key and is exactly why the allowlist must stay complete. */
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
    // The pre-rebuild bootstrap: the overlay this very add composes is what installs the client, so a missing
    // client is a soft outcome. Failing here would make the capability impossible to add at all.
    const { ctx } = tempCtx();
    const lines = await drain(exitHandler.apply(ctx, "berlin", tor("on")));
    expect(lines.join(" ")).toMatch(/doesn't carry tor yet/);
    expect(lines.join(" ")).toMatch(/Rebuild it/);
});

test("removing the last exit takes the shared skill with it, and an earlier one does not", async () => {
    const { ctx, root } = tempCtx();
    await drain(exitHandler.apply(ctx, "berlin", tor()));
    expect(() => readFileSync(skillPath(root), "utf8")).not.toThrow();

    // Two exits configured: removing one must leave the skill, since the other still needs it. The route
    // removes the manifest entry AFTER the handler, so the one being removed is still in the list.
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
