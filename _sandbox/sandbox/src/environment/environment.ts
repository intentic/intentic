import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import { capabilityFragments, workspaceExtensionFragments } from "./fragment-sources.js";
import { providerPackFragments } from "./provider-packs.js";
import { statePath } from "../workspace/state-paths.js";

// The overlay Dockerfile extending the sandbox image. The approved file is DAEMON-COMPOSED from three parts:
// the pinned FROM, the enabled capabilities' code-versioned fragments (see CapabilityHandler.fragment), and the
// owner-approved custom section. The agent writes the proposal (custom-section content only, no FROM, no
// runtime directives) with its normal file tools; the owner-gated approve route stores it as the custom file
// and recomposes. The container can't rebuild itself (no docker socket), an outside executor (`ic sandbox rebuild`
// served at intentic.dev/rebuild, or the workspace provider) verifies the approved content against the hash pinned in the rebuild
// command, builds, and recreates with SANDBOX_ENVIRONMENT_HASH stamped. Status is derived, never stored.

export const proposalPath = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.Dockerfile");
export const approvedPath = (services: Services): string => statePath(services.workspace.root, ".intentic/local/environment.approved.Dockerfile");
export const customPath = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.custom.Dockerfile");

// The overlay extends the image this sandbox is actually on, not a fixed tag. Hardcoding `:stable` meant every
// environment rebuild silently rolled the daemon back to the last release: a sandbox started on `:latest` or a
// pinned SHA (SANDBOX_IMAGE, which connect.sh passes through) came back from a rebuild older than it went in,
// with no sign a downgrade happened. A capability whose whole point is its image fragment (vpn) is the worst
// case, applying the fragment and running a daemon that understands it become mutually exclusive.
const RELEASE_IMAGE = "ghcr.io/intentic/sandbox:stable";
const OFFICIAL_IMAGE = /^ghcr\.io\/intentic\/sandbox:\S+$/;

// Both inputs are RUNNER-set container env (SANDBOX_BASE_IMAGE / SANDBOX_IMAGE), never anything the agent can
// write, so neither is a path for smuggling a base image past the owner.
//
// `baseImage` wins because after a rebuild `runningImage` is the overlay's own tag
// (`intentic-sandbox-env-<slug>:<hash>`, see the ic recreate flow), which is not a base at
// all. Preferring the running image there would flip the composed FROM on every recompose, changing the
// content, changing its hash, and asking the owner to rebuild AGAIN, the endless prompt, which each time also
// downgraded them to whatever `:stable` happened to be.
//
// An unofficial ref is honoured ONLY when the runner named it explicitly as the base: that is the local dev
// image (`intentic-sandbox:dev`), where the alternative is worse, a rebuild that silently replaces a
// developer's freshly-built daemon with the last release. Deriving a base from `runningImage` stays restricted
// to official refs, so a stock sandbox can never end up extending something unofficial by inference.
// Blank-checked rather than `!== ""`: this value ends up verbatim in a FROM line, so anything unset must fall
// through to a real image instead of composing `FROM undefined`, an overlay that fails to build at all.
export const baseImageOf = (baseImage: string | undefined, runningImage: string | undefined): string => {
    if (baseImage !== undefined && baseImage.trim() !== "") {
        return baseImage.trim();
    }
    const running = runningImage?.trim() ?? "";
    return OFFICIAL_IMAGE.test(running) ? running : RELEASE_IMAGE;
};

// The composed overlay must extend the official sandbox image, the first instruction is pinned so an approved
// overlay can't swap the base for an arbitrary image. Held by construction in composeEnvironment; the ic recreate flow
// re-checks it as a redundant safety check.
export const hasValidBase = (content: string): boolean => {
    const first = content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
    return first !== undefined && /^FROM ghcr\.io\/intentic\/sandbox:\S+$/.test(first);
};

// A proposal is custom-section content only: the daemon owns the base pin (no FROM) and runtime directives are
// reserved for capability fragments (a proposal can't smuggle container privileges).
const invalidProposal = (content: string): boolean =>
    content.split("\n").some((line) => /^\s*from\s/i.test(line)) || content.includes("intentic:runtime");

const HEADER =
    "# Composed by the intentic sandbox daemon — do not edit by hand.\n" +
    "# Capability fragments are daemon-owned; the custom section mirrors .intentic/config/environment.custom.Dockerfile.";
const CUSTOM_MARKER = "# ---- custom (owner-approved) ----";

/* Persist a DERIVED file only when it actually derives to something new.
 *
 * Every file this module writes is composed from other state, so a recompose that lands on what is already
 * there has changed nothing, but an unconditional write says otherwise to the one reader that cannot check:
 * the workspace watcher, which reports the mtime bump, which the browser turns into "the `environment` query
 * is stale" (WORKSPACE_STATE_FILES binds `.intentic/environment.` to it).
 *
 * That is a closed loop when the recompose happens on a READ. `readEnvironment` folds pending drafts into the
 * proposal, so with any draft on disk: GET /environment writes → the watcher pushes → the browser invalidates
 * `environment` → GET /environment writes → … paced only by the watcher's 250ms debounce, which is four
 * requests a second forever, each frame also dragging a tree walk and a `git status` along behind it.
 * Comparing first ends it: the first read after a real draft change writes once, and the next composes the
 * same bytes and stays silent. */
const writeComposed = async (services: Services, path: string, content: string): Promise<void> => {
    if ((await services.files.read(path)) === content) {
        return;
    }
    await services.files.write(path, content);
};

// Regenerate the approved (composed) overlay from the capability manifest + the custom file. Returns the
// composed hash, or undefined when no overlay should exist. Called on capability add/remove, approve, and boot
// (boot converges fragment drift: a daemon update that changes a fragment flips the derived state to "pending
// rebuild" with no new state). ponytail: races the store's read-modify-write under concurrent adds, a stale
// compose self-heals on the next capability event or boot.
export const composeEnvironment = async (services: Services): Promise<string | undefined> => {
    const capabilities = await services.capabilities.list();
    const fragments = [
        ...new Set([
            ...(await Promise.all(capabilities.map((capability) => capabilityFragments(services, capability)))).flat(),
            ...(await workspaceExtensionFragments(services)),
            // The helper binaries a CONNECTED provider needs (codex/opencode/cli-proxy-api), for a base image
            // that doesn't already bake them, see provider-packs.ts.
            ...(await providerPackFragments(services)),
        ]),
    ].toSorted();
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    // The base this container was built from, so a rebuild is version-preserving rather than a silent rollback.
    const base = baseImageOf(services.config.sandbox.baseImage, services.config.sandbox.image);
    if (fragments.length === 0 && custom === "") {
        if (services.config.sandbox.environmentHash === "") {
            await services.files.remove(approvedPath(services));
            return undefined;
        }
        // The running container was built from an overlay that now has nothing left in it: keep a bare overlay
        // so the owner has a hash-pinned rebuild path back to stock.
        const bare = `${HEADER}\n\nFROM ${base}\n`;
        await writeComposed(services, approvedPath(services), bare);
        return sha256Hex(bare);
    }
    const sections = [HEADER, `FROM ${base}`, ...fragments, ...(custom === "" ? [] : [CUSTOM_MARKER, custom])];
    const content = `${sections.join("\n\n")}\n`;
    await writeComposed(services, approvedPath(services), content);
    return sha256Hex(content);
};

// Where an AGENT writes what it needs installed, one file per thing, named for it (`ffmpeg.Dockerfile`).
// Not the proposal itself, for two reasons. Worktree-isolated agents run in PARALLEL, and a single shared
// proposal file makes concurrent drafts a last-writer-wins race in which one agent's request silently vanishes.
// And naming the file after the tool means two agents that both need ffmpeg converge on one entry instead of
// appending a near-duplicate each. The owner still reviews exactly one composed proposal.
export const draftsDir = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.d/");

const readDrafts = async (services: Services): Promise<string> => {
    const dir = draftsDir(services);
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".Dockerfile")).toSorted();
    const drafts = await Promise.all(
        names.map(async (name) => {
            const content = ((await services.files.read(join(dir, name))) ?? "").trim();
            return content === "" ? undefined : `# ---- ${name.slice(0, -".Dockerfile".length)} ----\n${content}`;
        }),
    );
    return drafts.filter((draft) => draft !== undefined).join("\n\n");
};

// Compose the proposal the owner reviews: the already-approved custom section plus every pending draft. The
// custom section is carried forward because approval REPLACES it wholesale, composing drafts alone would
// quietly uninstall everything approved before them. No drafts ⇒ leave the proposal untouched.
const mergeProposalDrafts = async (services: Services): Promise<void> => {
    const drafts = await readDrafts(services);
    if (drafts === "") {
        return;
    }
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    await writeComposed(services, proposalPath(services), `${[...(custom === "" ? [] : [custom]), drafts].join("\n\n")}\n`);
};

const fileState = async (services: Services, path: string): Promise<{ content: string; hash: string } | undefined> => {
    const content = await services.files.read(path);
    return content === undefined ? undefined : { content, hash: sha256Hex(content) };
};

export const readEnvironment = async (services: Services): Promise<Environment> => {
    // Fold in anything agents have drafted since the last read, so the card shows what they actually asked for
    // and its hash is the one approve will check against.
    await mergeProposalDrafts(services);
    const proposal = await fileState(services, proposalPath(services));
    const custom = await fileState(services, customPath(services));
    const approved = await fileState(services, approvedPath(services));
    const { environmentHash: appliedHash, name } = services.config.sandbox;
    return {
        ...(proposal !== undefined ? { proposal } : {}),
        ...(custom !== undefined ? { custom } : {}),
        ...(approved !== undefined ? { approved } : {}),
        ...(appliedHash !== "" ? { appliedHash } : {}),
        ...(name !== "" ? { container: name } : {}),
    };
};

// Store the proposal as the custom section and recompose, only when its content still hashes to what the
// owner reviewed (`mismatch` kills the TOCTOU where the agent swaps content after review) and it carries no
// FROM/runtime-directive lines. An empty proposal clears the custom section.
export const approveEnvironment = async (services: Services, hash: string): Promise<"missing" | "mismatch" | "invalid" | undefined> => {
    // Same fold as the read, so approve checks the hash against the same content the card rendered. A draft
    // that landed in between changes the content and so fails the hash check, which is the point: it sends
    // the owner back to re-read rather than approving a step they never saw.
    await mergeProposalDrafts(services);
    const proposal = await fileState(services, proposalPath(services));
    if (proposal === undefined) {
        return "missing";
    }
    if (proposal.hash !== hash) {
        return "mismatch";
    }
    if (invalidProposal(proposal.content)) {
        return "invalid";
    }
    await services.files.write(customPath(services), proposal.content);
    // The drafts are now IN the custom section; leaving them would recompose the same proposal on the next
    // read and ask the owner to approve what they just approved, forever.
    await services.files.remove(draftsDir(services));
    await composeEnvironment(services);
    return undefined;
};

// Rejecting drops the drafts too, otherwise the next read composes the rejected proposal straight back.
export const rejectEnvironment = async (services: Services): Promise<void> => {
    await services.files.remove(draftsDir(services));
    await services.files.remove(proposalPath(services));
};
