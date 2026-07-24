import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import {
    approvedPath,
    approveEnvironment,
    composeEnvironment,
    customPath,
    hasValidBase,
    proposalPath,
    readEnvironment,
    rejectEnvironment,
} from "./environment.js";

// A proposal is custom-section content only — the daemon owns the FROM.
const CUSTOM = "RUN apt-get update && apt-get install -y cowsay\n";

// The real first-party connectors/discord extensions, so a cli capability's image fragment resolves.
const EXTENSIONS_DIR = fileURLToPath(new URL("../../../../_extensions", import.meta.url));

const stubServices = (environmentHashApplied = "", capabilities: Capability[] = []): Services =>
    ({
        config: { sandbox: { environmentHash: environmentHashApplied, name: "intentic-sandbox-demo" }, extensionsDir: EXTENSIONS_DIR },
        workspace: { root: mkdtempSync(join(tmpdir(), "environment-")) },
        files: { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath },
        logger: { warn: () => undefined },
        capabilities: { list: async () => capabilities },
    }) as unknown as Services;

const vpn = (id: string): Capability => ({
    id,
    kind: "vpn",
    config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
});
const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "t" } };

test("hasValidBase pins the first instruction to the official sandbox image", () => {
    expect(hasValidBase("FROM registry.gitlab.com/radarsu/intentic/sandbox:stable\nRUN true\n")).toBe(true);
    expect(hasValidBase("# comment\n\nFROM registry.gitlab.com/radarsu/intentic/sandbox:1.52.0\nRUN true\n")).toBe(true);
    expect(hasValidBase("FROM alpine:latest\n")).toBe(false);
    expect(hasValidBase("FROM registry.gitlab.com/radarsu/intentic/sandbox:\n")).toBe(false);
    expect(hasValidBase("RUN true\nFROM registry.gitlab.com/radarsu/intentic/sandbox:stable\n")).toBe(false);
    expect(hasValidBase("")).toBe(false);
});

test("propose → approve stores the custom section and recomposes; applied derives from the composed hash", async () => {
    const services = stubServices();
    expect(await readEnvironment(services)).toEqual({ container: "intentic-sandbox-demo" });

    // The agent's Write of the proposal file IS the proposal.
    await services.files.write(proposalPath(services), CUSTOM);
    const hash = sha256Hex(CUSTOM);
    expect(await readEnvironment(services)).toEqual({ proposal: { content: CUSTOM, hash }, container: "intentic-sandbox-demo" });

    expect(await approveEnvironment(services, hash)).toBeUndefined();
    const state = await readEnvironment(services);
    expect(state.proposal).toEqual({ content: CUSTOM, hash });
    expect(state.custom).toEqual({ content: CUSTOM, hash });
    // The approved file is the daemon-composed artifact: pinned base + the custom section verbatim (trimmed).
    expect(state.approved).toBeDefined();
    expect(hasValidBase(state.approved!.content)).toBe(true);
    expect(state.approved!.content).toContain("# ---- custom (owner-approved) ----");
    expect(state.approved!.content).toContain(CUSTOM.trim());
    expect(state.approved!.hash).not.toBe(hash);

    // The executor stamps SANDBOX_ENVIRONMENT_HASH on recreate — the UI reads applied from the hash equality.
    const applied = await readEnvironment(stubServices(state.approved!.hash));
    expect(applied.appliedHash).toBe(state.approved!.hash);
});

test("approve refuses a missing proposal, a reviewed-content mismatch, a FROM line, and a runtime directive", async () => {
    const services = stubServices();
    expect(await approveEnvironment(services, "whatever")).toBe("missing");

    await services.files.write(proposalPath(services), CUSTOM);
    // The TOCTOU gate: the hash the owner reviewed no longer matches the file's content.
    expect(await approveEnvironment(services, sha256Hex("RUN evil\n"))).toBe("mismatch");

    const withFrom = "FROM alpine:latest\nRUN true\n";
    await services.files.write(proposalPath(services), withFrom);
    expect(await approveEnvironment(services, sha256Hex(withFrom))).toBe("invalid");

    const withDirective = "RUN true\n# intentic:runtime --cap-add=SYS_ADMIN\n";
    await services.files.write(proposalPath(services), withDirective);
    expect(await approveEnvironment(services, sha256Hex(withDirective))).toBe("invalid");

    // No failure wrote the custom or approved files.
    const state = await readEnvironment(services);
    expect(state.custom).toBeUndefined();
    expect(state.approved).toBeUndefined();
});

test("reject deletes the proposal and leaves the approved custom section untouched", async () => {
    const services = stubServices();
    await services.files.write(proposalPath(services), CUSTOM);
    expect(await approveEnvironment(services, sha256Hex(CUSTOM))).toBeUndefined();

    await services.files.write(proposalPath(services), `${CUSTOM}RUN echo next\n`);
    await rejectEnvironment(services);
    const state = await readEnvironment(services);
    expect(state.proposal).toBeUndefined();
    expect(state.custom).toEqual({ content: CUSTOM, hash: sha256Hex(CUSTOM) });
    expect(state.approved).toBeDefined();
});

test("compose folds a capability's fragment (install + runtime directives) into a valid overlay", async () => {
    const services = stubServices("", [vpn("office")]);
    const hash = await composeEnvironment(services);
    const approved = await services.files.read(approvedPath(services));
    expect(approved).toBeDefined();
    expect(hash).toBe(sha256Hex(approved!));
    expect(hasValidBase(approved!)).toBe(true);
    expect(approved).toContain("wireguard-tools");
    expect(approved).toContain("# intentic:runtime --device=/dev/net/tun");
    expect(approved).toContain("# intentic:runtime --cap-add=NET_ADMIN");
});

test("compose dedupes identical fragments and orders distinct ones canonically", async () => {
    // Two vpn entries share one fragment; discord adds whisper. Lexicographic content order is manifest-independent.
    const services = stubServices("", [vpn("office"), discord, vpn("home-lab")]);
    await composeEnvironment(services);
    const approved = (await services.files.read(approvedPath(services)))!;
    expect(approved.split("wireguard-tools").length - 1).toBe(1);
    expect(approved).toContain("whisper-cli");
    expect(approved.indexOf("# discord voice")).toBeLessThan(approved.indexOf("# vpn capability"));

    const reordered = stubServices("", [discord, vpn("office")]);
    await composeEnvironment(reordered);
    // Same content (and so same hash) regardless of manifest order or duplicate count.
    expect(await services.files.read(approvedPath(reordered))).toBe(approved);
});

test("compose with nothing left removes the overlay on a stock container, keeps a bare one on an overlay build", async () => {
    // Stock container (no applied hash): removing the last fragment reverts to no overlay at all.
    const stock = stubServices();
    await stock.files.write(approvedPath(stock), "stale");
    expect(await composeEnvironment(stock)).toBeUndefined();
    expect(await stock.files.read(approvedPath(stock))).toBeUndefined();

    // A container built from an overlay keeps a bare FROM overlay — the hash-pinned rebuild path back to stock.
    const overlayBuilt = stubServices("deadbeef");
    const hash = await composeEnvironment(overlayBuilt);
    const bare = await overlayBuilt.files.read(approvedPath(overlayBuilt));
    expect(bare).toBeDefined();
    expect(hash).toBe(sha256Hex(bare!));
    expect(hasValidBase(bare!)).toBe(true);
    expect(bare).not.toContain("# ---- custom");
});

test("an empty approved proposal clears the custom section", async () => {
    const services = stubServices();
    await services.files.write(proposalPath(services), CUSTOM);
    expect(await approveEnvironment(services, sha256Hex(CUSTOM))).toBeUndefined();
    await services.files.write(proposalPath(services), "");
    expect(await approveEnvironment(services, sha256Hex(""))).toBeUndefined();
    expect(await services.files.read(customPath(services))).toBe("");
    // Nothing left to compose on a stock container ⇒ the overlay is gone.
    expect(await services.files.read(approvedPath(services))).toBeUndefined();
});
