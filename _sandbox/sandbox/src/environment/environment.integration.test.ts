import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import {
    approvedPath,
    approveEnvironment,
    composeEnvironment,
    customPath,
    draftsDir,
    baseImageOf,
    hasValidBase,
    proposalPath,
    readEnvironment,
    rejectEnvironment,
} from "./environment.js";

// A proposal is custom-section content only — the daemon owns the FROM.
const CUSTOM = "RUN apt-get update && apt-get install -y cowsay\n";

// The moving release tag the base falls back to when nothing official is available.
const RELEASE = "ghcr.io/intentic/sandbox:stable";

// The real first-party connectors/discord extensions, so a cli capability's image fragment resolves.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const stubServices = (environmentHashApplied = "", capabilities: Capability[] = [], image = "", baseImage = ""): Services =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", {
            // `sandbox` is DATA, so it is spelled out whole rather than stood in for: a stand-in answering every
            // unread field with a throwing function would make `publicUrl` read as set.
            sandbox: {
                port: 8787,
                host: "0.0.0.0",
                publicUrl: "",
                allowUnauthenticated: false,
                environmentHash: environmentHashApplied,
                name: "intentic-sandbox-demo",
                image,
                baseImage,
                channel: "",
                previousImage: "",
            },
            extensionsDir: EXTENSIONS_DIR,
            // Read by the provider-pack fragment source (codexConnected) on every compose — empty: no provider.
            openaiApiKey: "",
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "environment-")) }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        // The other two provider-pack predicates: an empty auth dir (no translator subscriptions on disk) and
        // no xAI sign-in — compose then carries no provider fragments, which is what these tests are shaped for.
        authRoot: mkdtempSync(join(tmpdir(), "environment-auth-")),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
    });

const vpn = (id: string): Capability => ({
    id,
    kind: "vpn",
    config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
});
const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "t" } };

test("hasValidBase pins the first instruction to the official sandbox image", () => {
    expect(hasValidBase("FROM ghcr.io/intentic/sandbox:stable\nRUN true\n")).toBe(true);
    expect(hasValidBase("# comment\n\nFROM ghcr.io/intentic/sandbox:1.52.0\nRUN true\n")).toBe(true);
    expect(hasValidBase("FROM alpine:latest\n")).toBe(false);
    expect(hasValidBase("FROM ghcr.io/intentic/sandbox:\n")).toBe(false);
    expect(hasValidBase("RUN true\nFROM ghcr.io/intentic/sandbox:stable\n")).toBe(false);
    expect(hasValidBase("")).toBe(false);
});

test("baseImageOf prefers the runner-named base, else an official running image, else the release tag", () => {
    const latest = "ghcr.io/intentic/sandbox:latest";
    // Fresh connect.sh run: no base named, and the running image IS the base.
    expect(baseImageOf("", latest)).toBe(latest);
    expect(baseImageOf("", "ghcr.io/intentic/sandbox:sha-abc1234")).toBe("ghcr.io/intentic/sandbox:sha-abc1234");
    // After a rebuild the running image is the overlay's own tag, which is not a base — the named base wins.
    // Getting this wrong is what produced the endless rebuild prompt AND rolled the sandbox back each time.
    expect(baseImageOf(latest, "intentic-sandbox-env-demo:abc123def456")).toBe(latest);
    // The dev loop: an unofficial ref is honoured only because the runner named it explicitly.
    expect(baseImageOf("intentic-sandbox:dev", "intentic-sandbox-dev-env-demo:abc123def456")).toBe("intentic-sandbox:dev");
    // Nothing named: an unofficial running image is never promoted to a base by inference.
    expect(baseImageOf("", "")).toBe(RELEASE);
    expect(baseImageOf("", "intentic-sandbox:dev")).toBe(RELEASE);
    expect(baseImageOf("", "evil.example.com/sandbox:latest")).toBe(RELEASE);
    // BACKWARD COMPATIBILITY: an overlaid sandbox created by a runner that predates SANDBOX_BASE_IMAGE runs an
    // `intentic-sandbox-env-<slug>:<hash>` image with no base named. It must still resolve to `:stable` — the
    // exact base the old daemon hardcoded — so upgrading composes byte-identical content and does NOT greet
    // the owner with a spurious "rebuild required".
    expect(baseImageOf("", "intentic-sandbox-env-demo:abc123def456")).toBe(RELEASE);
    expect(baseImageOf("", "intentic-sandbox-env:abc123def456")).toBe(RELEASE);
    // Unset/blank must never reach the FROM line verbatim — `FROM undefined` is an overlay that cannot build.
    expect(baseImageOf(undefined, undefined)).toBe(RELEASE);
    expect(baseImageOf("   ", "")).toBe(RELEASE);
});

test("a rebuild is version-preserving: composing again after one is byte-identical", async () => {
    const latest = "ghcr.io/intentic/sandbox:latest";
    const services = stubServices("", [vpn("office")], latest);

    const first = await composeEnvironment(services);
    const approved = (await services.files.read(approvedPath(services)))!;
    expect(approved).toContain(`FROM ${latest}`);
    expect(hasValidBase(approved)).toBe(true);

    // Recompose as the daemon does on boot AFTER a rebuild: the container now runs the overlay's own tag, with
    // the base named by recreate.sh and the applied hash stamped. Identical content and hash ⇒ the Environment
    // card stays quiet instead of asking for another rebuild.
    const rebuilt = stubServices(first!, [vpn("office")], "intentic-sandbox-env-demo:abc123def456", latest);
    expect(await composeEnvironment(rebuilt)).toBe(first);
    expect(await rebuilt.files.read(approvedPath(rebuilt))).toBe(approved);
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

// Agents draft into environment.d/<tool>.Dockerfile rather than into the proposal, because worktree-isolated
// agents run in parallel and a shared proposal file loses one of two concurrent drafts outright.
test("drafts from parallel agents compose into one proposal, in a stable order", async () => {
    const services = stubServices();
    const dir = draftsDir(services);
    await services.files.write(join(dir, "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await services.files.write(join(dir, "cowsay.Dockerfile"), "RUN apt-get install -y cowsay\n");

    const { proposal } = await readEnvironment(services);
    expect(proposal?.content).toContain("ffmpeg");
    expect(proposal?.content).toContain("cowsay");
    // Sorted by filename, so the same set of drafts always hashes the same — an unstable order would ask the
    // owner to re-approve identical content on every read.
    expect(proposal!.content.indexOf("cowsay")).toBeLessThan(proposal!.content.indexOf("ffmpeg"));
});

/* Folding drafts in happens on a READ, so it may write only when the fold produces something new.
 *
 * An unconditional write is a change as far as the workspace watcher can tell, and the browser binds
 * `.intentic/environment.` to the `environment` query (WORKSPACE_STATE_FILES) — so GET /environment pushed a
 * frame that invalidated the query that refetched GET /environment, forever, paced by the watcher's 250ms
 * debounce. Four requests a second, each frame also dragging a tree walk and a `git status` behind it. */
test("re-reading unchanged drafts writes nothing, so the watcher has no change to report", async () => {
    const services = stubServices();
    await services.files.write(join(draftsDir(services), "ffmpeg.Dockerfile"), "RUN apt-get install -y ffmpeg\n");

    const written: string[] = [];
    const counted = unstubbed<Services>("services", {
        config: services.config,
        workspace: services.workspace,
        logger: services.logger,
        capabilities: services.capabilities,
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
