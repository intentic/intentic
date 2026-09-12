import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { packFragment } from "./packs.js";
import { AUTO_MARKER } from "./auto-drafts.js";
import { fileRuntimeInstallsStore } from "./runtime-installs.js";
import { hasOfficialBase } from "@intentic/sandbox-contract";
import {
    approvedPath,
    approveEnvironment,
    composeEnvironment,
    customPath,
    decideRuntimeInstall,
    draftsDir,
    baseImageOf,
    proposalPath,
    readEnvironment,
    rejectEnvironment,
    withoutRuntimeDirectives,
} from "./environment.js";

// Pins PACK_STAMPS_DIR to an empty directory so every compose here means "no base image bakes this pack," regardless of
// whether the machine running the suite has /opt/packs (CI does not, a sandbox does).
process.env["INTENTIC_PACK_STAMPS_DIR"] = mkdtempSync(join(tmpdir(), "environment-stamps-"));

// A proposal is custom-section content only: the daemon owns the FROM.
const CUSTOM = "RUN apt-get update && apt-get install -y cowsay\n";

// The moving release tag the base falls back to when nothing official is available.
const RELEASE = "ghcr.io/intentic/sandbox:stable";

// The real first-party connectors/discord extensions, so a cli capability's image fragment resolves.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const stubServices = (environmentHashApplied = "", capabilities: Capability[] = [], image = "", baseImage = ""): Services =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", {
            // `sandbox` is spelled out whole, not stubbed: a throw-on-read stand-in would make an unread field look
            // set.
            sandbox: {
                profile: "container",
                port: 8787,
                host: "0.0.0.0",
                publicUrl: "",
                vm: false,
                grant: "",
                allowUnauthenticated: false,
                environmentHash: environmentHashApplied,
                name: "intentic-sandbox-demo",
                image,
                baseImage,
                channel: "",
                previousImage: "",
                definitionSeed: "",
                devRoot: undefined,
                prewarm: false,
            },
            extensionsDir: EXTENSIONS_DIR,
            // Read by the provider-pack fragment source (codexConnected) on every compose, empty: no provider.
            openaiApiKey: "",
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "environment-")) }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath }),
        // Real store on the throwaway root; readEnvironment folds the ledger in, so a stub would throw immediately.
        runtimeInstalls: fileRuntimeInstallsStore(join(tmpdir(), `runtime-installs-${Math.random().toString(36).slice(2)}.json`)),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        // Empty auth dir plus no xAI sign-in means compose carries no provider fragments, which these tests assume.
        authRoot: mkdtempSync(join(tmpdir(), "environment-auth-")),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
    });

const vpn = (id: string): Capability => ({
    id,
    kind: "vpn",
    config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
});
const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "t" } };

test("baseImageOf prefers the runner-named base, else an official running image, else the release tag", () => {
    const latest = "ghcr.io/intentic/sandbox:latest";
    // Fresh connect.sh run: no base named, so the running image is the base.
    expect(baseImageOf("", latest)).toBe(latest);
    expect(baseImageOf("", "ghcr.io/intentic/sandbox:sha-abc1234")).toBe("ghcr.io/intentic/sandbox:sha-abc1234");
    // After a rebuild the running image is the overlay's own tag, not a base; the named base wins instead.
    expect(baseImageOf(latest, "intentic-sandbox-env-demo:abc123def456")).toBe(latest);
    // The dev loop: an unofficial ref is honoured only because the runner named it explicitly.
    expect(baseImageOf("intentic-sandbox:dev", "intentic-sandbox-dev-env-demo:abc123def456")).toBe("intentic-sandbox:dev");
    // Nothing named: an unofficial running image is never promoted to a base by inference.
    expect(baseImageOf("", "")).toBe(RELEASE);
    expect(baseImageOf("", "intentic-sandbox:dev")).toBe(RELEASE);
    expect(baseImageOf("", "evil.example.com/sandbox:latest")).toBe(RELEASE);
    // An overlay tag is not a base, so it falls to the release rather than a spurious rebuild prompt.
    expect(baseImageOf("", "intentic-sandbox-env-demo:abc123def456")).toBe(RELEASE);
    expect(baseImageOf("", "intentic-sandbox-env:abc123def456")).toBe(RELEASE);
    // Unset/blank must never reach the FROM line verbatim: FROM undefined is an overlay that cannot build.
    expect(baseImageOf(undefined, undefined)).toBe(RELEASE);
    expect(baseImageOf("   ", "")).toBe(RELEASE);
});

test("a rebuild is version-preserving: composing again after one is byte-identical", async () => {
    const latest = "ghcr.io/intentic/sandbox:latest";
    const services = stubServices("", [vpn("office")], latest);

    const first = await composeEnvironment(services);
    const approved = (await services.files.read(approvedPath(services)))!;
    expect(approved).toContain(`FROM ${latest}`);
    expect(hasOfficialBase(approved)).toBe(true);

    // Simulates post-rebuild boot: running the overlay's own tag; identical hash keeps the card quiet.
    const rebuilt = stubServices(first!, [vpn("office")], "intentic-sandbox-env-demo:abc123def456", latest);
    expect(await composeEnvironment(rebuilt)).toBe(first);
    expect(await rebuilt.files.read(approvedPath(rebuilt))).toBe(approved);
});

test("propose → approve stores the custom section and recomposes; applied derives from the composed hash", async () => {
    const services = stubServices();
    expect(await readEnvironment(services)).toEqual({ container: "intentic-sandbox-demo" });

    // The agent's write of the proposal file is the proposal.
    await services.files.write(proposalPath(services), CUSTOM);
    const hash = sha256Hex(CUSTOM);
    expect(await readEnvironment(services)).toEqual({ proposal: { content: CUSTOM, hash }, container: "intentic-sandbox-demo" });

    expect(await approveEnvironment(services, hash)).toBeUndefined();
    const state = await readEnvironment(services);
    expect(state.proposal).toEqual({ content: CUSTOM, hash });
    expect(state.custom).toEqual({ content: CUSTOM, hash });
    // The approved file is the daemon-composed artifact: pinned base + the custom section verbatim (trimmed).
    expect(state.approved).toEqual(expect.any(Object));
    expect(hasOfficialBase(state.approved!.content)).toBe(true);
    expect(state.approved!.content).toContain("# ---- custom (owner-approved) ----");
    expect(state.approved!.content).toContain(CUSTOM.trim());
    expect(state.approved!.hash).not.toBe(hash);

    // The executor stamps SANDBOX_ENVIRONMENT_HASH on recreate: the UI reads applied from the hash equality.
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

    // No failure path writes the custom or approved files.
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
    expect(state.approved).toEqual(expect.any(Object));
});

test("compose folds a capability's fragment (install + runtime directives) into a valid overlay", async () => {
    const services = stubServices("", [vpn("office")]);
    const hash = await composeEnvironment(services);
    const approved = await services.files.read(approvedPath(services));
    expect(approved).toEqual(expect.any(String));
    expect(hash).toBe(sha256Hex(approved!));
    expect(hasOfficialBase(approved!)).toBe(true);
    expect(approved).toContain("wireguard-tools");
    expect(approved).toContain("# intentic:runtime --device=/dev/net/tun");
    expect(approved).toContain("# intentic:runtime --cap-add=NET_ADMIN");
});

test("compose dedupes identical fragments and orders distinct ones canonically", async () => {
    // Discord names the whisper pack instead of carrying one; rides only when the base doesn't bake it.
    const whisper = await packFragment("whisper");
    const services = stubServices("", [vpn("office"), discord, vpn("home-lab")]);
    await composeEnvironment(services);
    const approved = (await services.files.read(approvedPath(services)))!;
    expect(approved.split("wireguard-tools").length - 1).toBe(1);
    if (whisper === undefined) {
        expect(approved).not.toContain("whisper-cli");
    } else {
        expect(approved).toContain(whisper);
        expect(approved.indexOf("# vpn capability")).toBeLessThan(approved.indexOf(whisper));
    }

    const reordered = stubServices("", [discord, vpn("office")]);
    await composeEnvironment(reordered);
    // Same content and hash regardless of manifest order or duplicate count, asserted as byte equality.
    expect(await services.files.read(approvedPath(reordered))).toBe(approved);
});

test("compose with nothing left removes the overlay on a stock container, keeps a bare one on an overlay build", async () => {
    // Stock container (no applied hash): removing the last fragment reverts to no overlay at all.
    const stock = stubServices();
    await stock.files.write(approvedPath(stock), "stale");
    expect(await composeEnvironment(stock)).toBeUndefined();
    expect(await stock.files.read(approvedPath(stock))).toBeUndefined();

    // A container built from an overlay keeps a bare FROM overlay: the hash-pinned rebuild path back to stock.
    const overlayBuilt = stubServices("deadbeef");
    const hash = await composeEnvironment(overlayBuilt);
    const bare = await overlayBuilt.files.read(approvedPath(overlayBuilt));
    expect(bare).toEqual(expect.any(String));
    expect(hash).toBe(sha256Hex(bare!));
    expect(hasOfficialBase(bare!)).toBe(true);
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

// Agents draft into environment.d/<tool>.Dockerfile, not the proposal, since parallel worktree-isolated agents writing
// one shared file would lose a concurrent draft.
test("drafts from parallel agents compose into one proposal, in a stable order", async () => {
    const services = stubServices();
    const dir = draftsDir(services);
    await services.files.write(join(dir, "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await services.files.write(join(dir, "cowsay.Dockerfile"), "RUN apt-get install -y cowsay\n");

    const { proposal } = await readEnvironment(services);
    expect(proposal?.content).toContain("ffmpeg");
    expect(proposal?.content).toContain("cowsay");
    // Sorted by filename so the same set of drafts always hashes the same; no re-approve for nothing new.
    expect(proposal!.content.indexOf("cowsay")).toBeLessThan(proposal!.content.indexOf("ffmpeg"));
});

// Folding drafts happens on read, writing only when something changed: an unconditional write would look like a change
// to the workspace watcher, retriggering the very GET /environment query that just ran.
test("re-reading unchanged drafts writes nothing, so the watcher has no change to report", async () => {
    const services = stubServices();
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");

    const written: string[] = [];
    const counted = unstubbed<Services>("services", {
        config: services.config,
        workspace: services.workspace,
        logger: services.logger,
        capabilities: services.capabilities,
        runtimeInstalls: services.runtimeInstalls,
        files: unstubbed<Services["files"]>("files", {
            read: services.files.read,
            remove: services.files.remove,
            write: async (path, content) => {
                written.push(path);
                await services.files.write(path, content);
            },
        }),
    });

    // The first read composes something the disk does not have yet, so it persists the proposal exactly once.
    expect((await readEnvironment(counted)).proposal?.content).toContain("ffmpeg");
    expect(written).toEqual([proposalPath(counted)]);

    // Every read after it composes the same bytes, and so must be silent.
    written.length = 0;
    await readEnvironment(counted);
    await readEnvironment(counted);
    expect(written).toEqual([]);
});

test("a draft carries the already-approved custom section forward", async () => {
    const services = stubServices();
    await services.files.write(proposalPath(services), CUSTOM);
    expect(await approveEnvironment(services, sha256Hex(CUSTOM))).toBeUndefined();

    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    const { proposal } = await readEnvironment(services);
    // Approval REPLACES the custom section, so dropping cowsay here would uninstall it on the next rebuild.
    expect(proposal?.content).toContain("cowsay");
    expect(proposal?.content).toContain("ffmpeg");
});

test("approving clears the drafts, so the same request is not proposed forever", async () => {
    const services = stubServices();
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    const { proposal } = await readEnvironment(services);
    expect(await approveEnvironment(services, proposal!.hash)).toBeUndefined();

    const after = await readEnvironment(services);
    expect(after.custom?.content).toContain("ffmpeg");
    expect(after.proposal?.content).toBe(proposal!.content);
    // The drafts are gone: a second approve finds nothing new to fold in.
    await services.files.write(customPath(services), "RUN true\n");
    const reread = await readEnvironment(services);
    expect(reread.proposal?.content).toBe(proposal!.content);
});

test("rejecting drops the drafts, not just the composed proposal", async () => {
    const services = stubServices();
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await readEnvironment(services);

    await rejectEnvironment(services);
    expect((await readEnvironment(services)).proposal).toBeUndefined();
});

test("rejecting an AUTO-drafted step tombstones its tool; an agent's draft is only deleted", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "apt", tool: "nsis" }], "apt-get install -y nsis", "s1", 1_000);
    await services.files.write(join(draftsDir(services), "nsis.Dockerfile"), `${AUTO_MARKER} nsis\nRUN apt-get install -y nsis\n`);
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await readEnvironment(services);

    await rejectEnvironment(services);
    const { installs } = await services.runtimeInstalls.read();
    // The machine is told to stop repeating itself; the agent remains free to ask again.
    expect(installs.find((entry) => entry.tool === "nsis")?.declinedAt).toEqual(expect.any(Number));
    expect((await readEnvironment(services)).proposal).toBeUndefined();
});

test("the payload carries recurring runtime installs, and drops the ones the custom section already bakes", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install --locked cargo-xwin", "s1", 1_000);
    await services.runtimeInstalls.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install --locked cargo-xwin", "s2", 2_000);
    await services.runtimeInstalls.record([{ kind: "apt", tool: "ffmpeg" }], "apt-get install -y ffmpeg", "s1", 1_000);
    await services.runtimeInstalls.record([{ kind: "apt", tool: "ffmpeg" }], "apt-get install -y ffmpeg", "s2", 2_000);
    await services.files.write(customPath(services), "# ---- ffmpeg ----\nRUN apt-get update && apt-get install -y ffmpeg\n");

    const { recurring } = await readEnvironment(services);
    // ffmpeg is already the owner's approved custom section: recurrence about it is stale news.
    expect(recurring?.map((entry) => entry.tool)).toEqual(["cargo-xwin"]);
    expect(recurring?.[0]).toMatchObject({ kind: "cargo", sessions: 2 });
});

test("a one-session install that is not live in this container stays off the card", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "apt", tool: "jq" }], "apt-get install -y jq", "s1", 1_000);
    expect((await readEnvironment(services)).recurring).toBeUndefined();
});

// Lets the owner answer one recurring entry directly (adopt, dismiss, restore), for ecosystems with no mechanical
// template that would otherwise have no route to a draft or a tombstone.

test("adopting writes the tool's overlay draft on the owner's say-so, without the sweep's gates", async () => {
    const services = stubServices();
    // One session, no corroboration: the sweep would refuse this, rightly, since nobody asked.
    await services.runtimeInstalls.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install --locked cargo-xwin", "s1", 1_000);

    expect(await decideRuntimeInstall(services, { tool: "cargo-xwin", decision: "adopt" })).toBeUndefined();
    const draft = await readWorkspaceFile(join(draftsDir(services), "cargo-xwin.Dockerfile"));
    expect(draft).toContain("RUN cargo install --locked cargo-xwin");
    expect(draft?.split("\n")[0]).toBe(`${AUTO_MARKER} cargo-xwin`);
    // And it reaches the owner as a proposal to approve, which is the only reason writing it is worth anything.
    expect((await readEnvironment(services)).proposal?.content).toContain("cargo install --locked cargo-xwin");
});

test("a kind with no mechanical step cannot be adopted, and says so rather than writing nothing quietly", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "pip", tool: "zizmor" }], "pip install zizmor", "s1", 1_000);
    expect(await decideRuntimeInstall(services, { tool: "zizmor", decision: "adopt" })).toBe("unavailable");
});

test("dismissing tombstones one tool and takes its auto-draft with it; undoing clears the tombstone", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "apt", tool: "nsis" }], "apt-get install -y nsis", "s1", 1_000);
    await services.files.write(join(draftsDir(services), "nsis.Dockerfile"), `${AUTO_MARKER} nsis\nRUN apt-get install -y nsis\n`);
    // An agent's own draft carries no marker; dismissing a ledger line doesn't answer an agent's own ask.
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");

    await decideRuntimeInstall(services, { tool: "nsis", decision: "dismiss" });
    expect((await services.runtimeInstalls.read()).installs.find((entry) => entry.tool === "nsis")?.declinedAt).toEqual(expect.any(Number));
    expect(await readWorkspaceFile(join(draftsDir(services), "nsis.Dockerfile"))).toBeUndefined();
    expect(await readWorkspaceFile(join(draftsDir(services), "ffmpeg.Dockerfile"))).toContain("ffmpeg");

    await decideRuntimeInstall(services, { tool: "nsis", decision: "restore" });
    expect((await services.runtimeInstalls.read()).installs.find((entry) => entry.tool === "nsis")?.declinedAt).toBeUndefined();
});

test("dismissing the last drafted tool leaves no proposal standing over a file that is gone", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "apt", tool: "nsis" }], "apt-get install -y nsis", "s1", 1_000);
    await services.files.write(join(draftsDir(services), "nsis.Dockerfile"), `${AUTO_MARKER} nsis\nRUN apt-get install -y nsis\n`);
    expect((await readEnvironment(services)).proposal?.content).toContain("nsis");

    await decideRuntimeInstall(services, { tool: "nsis", decision: "dismiss" });
    expect((await readEnvironment(services)).proposal).toBeUndefined();
});

test("the recurring row carries the step that would bake it, so the card can show what a press would add", async () => {
    const services = stubServices();
    await services.runtimeInstalls.record([{ kind: "playwright", tool: "chromium-headless-shell" }], "npx playwright install", "s1", 1_000);
    await services.runtimeInstalls.record([{ kind: "playwright", tool: "chromium-headless-shell" }], "npx playwright install", "s2", 2_000);
    await services.runtimeInstalls.record([{ kind: "pip", tool: "zizmor" }], "pip install zizmor", "s1", 1_000);
    await services.runtimeInstalls.record([{ kind: "pip", tool: "zizmor" }], "pip install zizmor", "s2", 2_000);

    const { recurring } = await readEnvironment(services);
    expect(recurring?.find((entry) => entry.tool === "chromium-headless-shell")?.step).toContain("playwright install --with-deps");
    // Absent is the honest answer for a kind whose fix is a judgement call, and the card reads it as one.
    expect(recurring?.find((entry) => entry.tool === "zizmor")?.step).toBeUndefined();
});

test("a drift snapshot from a container that no longer exists is not reported", async () => {
    const services = stubServices();
    // bornAt 1970 can never be within jitter of the running container's birth.
    await services.runtimeInstalls.saveDrift({ bornAt: 1_000, at: 2_000, apt: ["xdg-utils"], paths: [] });
    expect((await readEnvironment(services)).drift).toBeUndefined();
});

// A directive-only fragment must vanish entirely: a hosted VM honours no runtime directive at all.
test("withoutRuntimeDirectives drops the directive lines and any fragment with no instruction left", () => {
    const directiveOnly = "# docker capability: this directive grants dockerd the privileges it needs\n# intentic:runtime --privileged";
    const install =
        "# vpn tools\nRUN apt-get install -y openconnect\n# intentic:runtime --cap-add=NET_ADMIN\n# intentic:runtime --device=/dev/net/tun";
    expect(withoutRuntimeDirectives([directiveOnly, install])).toEqual(["# vpn tools\nRUN apt-get install -y openconnect"]);
    expect(withoutRuntimeDirectives([])).toEqual([]);
});
