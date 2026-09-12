import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
    DEV_SANDBOX_IMAGE,
    type Environment,
    type EnvironmentRecurring,
    type EnvironmentRuntimeDecision,
    isOfficialSandboxImage,
} from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { AUTO_MARKER, autoDraftedTools, draftContent, draftFileName, named, stepFor } from "./auto-drafts.js";
import { containerBornAtMs, installLive } from "./drift.js";
import { capabilityFragments, workspaceExtensionFragments } from "./fragment-sources.js";
import { providerPackFragments } from "./provider-packs.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Overlay Dockerfile composed from the pinned FROM, each capability's fragment, and the owner-approved custom section.
// Agents propose custom-section content only; the owner-gated approve route stores it as custom and recomposes. An
// outside executor then verifies the approved hash, builds, and recreates with it stamped.

export const proposalPath = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.Dockerfile");
export const approvedPath = (services: Services): string => statePath(services.workspace.root, ".intentic/local/environment.approved.Dockerfile");
export const customPath = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.custom.Dockerfile");

// Extends the image this sandbox is actually on, not a fixed tag, so a rebuild can't silently roll it back.
const RELEASE_IMAGE = "ghcr.io/intentic/sandbox:stable";

// Both inputs are runner-set, never agent-writable. `baseImage` wins since `runningImage` after a rebuild is the
// overlay's own tag, not a base; an unofficial ref is only honoured when the runner named it explicitly (the dev
// image).
export const baseImageOf = (baseImage: string | undefined, runningImage: string | undefined): string => {
    if (baseImage !== undefined && baseImage.trim() !== "") {
        return baseImage.trim();
    }
    const running = runningImage?.trim() ?? "";
    return isOfficialSandboxImage(running) ? running : RELEASE_IMAGE;
};

// Composed overlay must extend the official sandbox image; the FROM line is pinned in composeEnvironment, and every
// executor (`ic`, the hosted rebuild) re-checks it via the contract's `hasOfficialBase`.

// A proposal is custom content only: no FROM (daemon owns the base) and no runtime directive (reserved for capability
// fragments).
const invalidProposal = (content: string): boolean =>
    content.split("\n").some((line) => /^\s*from\s/i.test(line)) || content.includes("intentic:runtime");

const HEADER =
    "# Composed by the intentic sandbox daemon: do not edit by hand.\n" +
    "# Capability fragments are daemon-owned; the custom section mirrors .intentic/config/environment.custom.Dockerfile.";
const CUSTOM_MARKER = "# ---- custom (owner-approved) ----";

// Writes a derived file only when its content actually changed; on a read-triggered recompose, an unconditional write
// would retrigger the workspace watcher into refetching the same query forever.
const writeComposed = async (services: Services, path: string, content: string): Promise<void> => {
    if ((await services.files.read(path)) === content) {
        return;
    }
    await services.files.write(path, content);
};

// Regenerates the approved overlay from the capability manifest and custom file; returns the composed hash, or
// undefined when none should exist. Runs on capability add/remove, approve, and boot, catching drift when a daemon
// update changes a fragment.
// On a hosted VM, already root over the whole machine, `# intentic:runtime` lines (privileges for a docker-run
// executor) are meaningless; stripped here along with any fragment left with no real instruction after they're gone.
export const withoutRuntimeDirectives = (fragments: readonly string[]): string[] =>
    fragments
        .map((fragment) =>
            fragment
                .split("\n")
                .filter((line) => !line.trim().startsWith("# intentic:runtime"))
                .join("\n")
                .trim(),
        )
        .filter((fragment) => fragment.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#")));

export const composeEnvironment = async (services: Services): Promise<string | undefined> => {
    const capabilities = await services.capabilities.list();
    const contributed = [
        ...new Set([
            ...(await Promise.all(capabilities.map((capability) => capabilityFragments(services, capability)))).flat(),
            ...(await workspaceExtensionFragments(services)),
            // Helper binaries a connected provider needs, for a base image that doesn't already bake them.
            ...(await providerPackFragments(services)),
        ]),
    ].toSorted();
    const fragments = services.config.sandbox.vm ? withoutRuntimeDirectives(contributed) : contributed;
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    // The base this container was built from, so a rebuild is version-preserving rather than a silent rollback.
    const base = baseImageOf(services.config.sandbox.baseImage, services.config.sandbox.image);
    if (fragments.length === 0 && custom === "") {
        if (services.config.sandbox.environmentHash === "") {
            await services.files.remove(approvedPath(services));
            return undefined;
        }
        // Built from an overlay now empty; keep a bare one so the owner has a hash-pinned path back to stock.
        const bare = `${HEADER}\n\nFROM ${base}\n`;
        await writeComposed(services, approvedPath(services), bare);
        return sha256Hex(bare);
    }
    const sections = [HEADER, `FROM ${base}`, ...fragments, ...(custom === "" ? [] : [CUSTOM_MARKER, custom])];
    const content = `${sections.join("\n\n")}\n`;
    await writeComposed(services, approvedPath(services), content);
    return sha256Hex(content);
};

// Where an agent writes what it needs, one file per tool. Not the proposal itself: parallel worktree-isolated agents
// sharing one file would race, and naming by tool lets two agents needing the same thing converge on one entry.
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

// Composes the proposal from the approved custom section plus every pending draft; carrying custom forward matters
// since approval replaces it wholesale. No drafts ⇒ proposal untouched.
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

// bornAt reads differ by clock-read jitter, so "same container" is a tolerance, not an equality.
const SAME_BIRTH_MS = 5_000;

// How many recurring entries the card is asked to carry; the ledger itself keeps more.
const RECURRING_SHOWN = 30;

// Drift snapshot (guarded against a stale container) and ledger entries worth attention, recurring or live in this
// container. Spawn-free since this route is polled; presence checks are stats, the walk belongs to the sweep.
const runtimeAttention = async (services: Services, baked: string): Promise<Pick<Environment, "drift" | "recurring">> => {
    const ledger = await services.runtimeInstalls.read();
    const born = await containerBornAtMs().catch(() => undefined);
    const drift = ledger.drift !== undefined && born !== undefined && Math.abs(ledger.drift.bornAt - born) < SAME_BIRTH_MS ? ledger.drift : undefined;
    const drafted = new Set(await autoDraftedTools(services));
    const recurring: EnvironmentRecurring[] = [];
    for (const entry of ledger.installs) {
        if (named(baked, entry.tool)) {
            continue;
        }
        const live = drift !== undefined && (await installLive(entry, drift));
        if (entry.sessions.length < 2 && !live) {
            continue;
        }
        const step = stepFor(entry);
        recurring.push({
            tool: entry.tool,
            kind: entry.kind,
            sessions: entry.sessions.length,
            lastAt: entry.lastAt,
            live,
            ...(drafted.has(entry.tool) ? { drafted: true } : {}),
            ...(entry.declinedAt !== undefined ? { declined: true } : {}),
            ...(step === undefined ? {} : { step }),
        });
    }
    // Answered entries sink before the cap: a dismissal must not spend a slot an undecided install still needs.
    recurring.sort((left, right) => Number(left.declined ?? false) - Number(right.declined ?? false) || right.lastAt - left.lastAt);
    return {
        ...(drift !== undefined ? { drift } : {}),
        ...(recurring.length > 0 ? { recurring: recurring.slice(0, RECURRING_SHOWN) } : {}),
    };
};

// What the runner stamped on THIS container, none of it agent-writable: the overlay it was built from, the name a
// rebuild targets, and whether its base was compiled from a checkout rather than published. That last one is the
// dogfood shape, and it changes what the Environment card can offer: such a sandbox is rebuilt from its checkout, and
// an update would move it onto the published image rather than refresh it.
export const containerFacts = (sandbox: Config["sandbox"]): Pick<Environment, "appliedHash" | "container" | "localImage"> => {
    const { environmentHash, name, devRoot } = sandbox;
    const base = baseImageOf(sandbox.baseImage, sandbox.image);
    return {
        ...(environmentHash === "" ? {} : { appliedHash: environmentHash }),
        ...(name === "" ? {} : { container: name }),
        ...(base === DEV_SANDBOX_IMAGE ? { localImage: { base, ...(devRoot === undefined ? {} : { root: devRoot }) } } : {}),
    };
};

export const readEnvironment = async (services: Services): Promise<Environment> => {
    // Folds in drafts since the last read, so the card's hash is the one approve will check against.
    await mergeProposalDrafts(services);
    const proposal = await fileState(services, proposalPath(services));
    const custom = await fileState(services, customPath(services));
    const approved = await fileState(services, approvedPath(services));
    // Approved contains custom by composition, so one string answers "already baked or already approved".
    const attention = await runtimeAttention(services, `${custom?.content ?? ""}\n${approved?.content ?? ""}`);
    return {
        ...(proposal !== undefined ? { proposal } : {}),
        ...(custom !== undefined ? { custom } : {}),
        ...(approved !== undefined ? { approved } : {}),
        ...containerFacts(services.config.sandbox),
        ...attention,
    };
};

// Stores the proposal as the custom section and recomposes, only if its hash still matches what the owner reviewed and
// it carries no FROM or runtime-directive line. An empty proposal clears the custom section.
export const approveEnvironment = async (services: Services, hash: string): Promise<"missing" | "mismatch" | "invalid" | undefined> => {
    // Same fold as the read; a mid-flight draft changes the hash and forces a re-read, not a blind approve.
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
    // Drafts are now in the custom section; leaving them would re-propose what the owner just approved, forever.
    await services.files.remove(draftsDir(services));
    await composeEnvironment(services);
    return undefined;
};

// Drops the drafts too, or the next read composes the rejected proposal right back. Auto-drafted ones are also
// tombstoned, so the sweep can't just re-earn and recreate them; agent-written ones are simply deleted, free to be
// asked for again.
export const rejectEnvironment = async (services: Services): Promise<void> => {
    const auto = await autoDraftedTools(services);
    if (auto.length > 0) {
        await services.runtimeInstalls.decline(auto, Date.now());
    }
    await services.files.remove(draftsDir(services));
    await services.files.remove(proposalPath(services));
};

// Answers one recurring entry: tombstones it and its auto-draft (else synthesis would never rewrite it), but leaves an
// agent's own hand-written draft alone. Restoring only clears the tombstone; the sweep re-earns the draft on its own
// terms.
const dismissRuntimeInstall = async (services: Services, tool: string): Promise<void> => {
    await services.runtimeInstalls.decline([tool], Date.now());
    const file = draftFileName(tool);
    if (file === undefined) {
        return;
    }
    const path = join(draftsDir(services), file);
    const content = await services.files.read(path);
    if (content?.startsWith(`${AUTO_MARKER} ${tool}`) === true) {
        await services.files.remove(path);
        // With no drafts left, a standing proposal would ask approval for a step whose file is already gone.
        if ((await readDrafts(services)) === "") {
            await services.files.remove(proposalPath(services));
        }
    }
};

// Writes the draft on the owner's say-so, skipping the sweep's gates since a person asking already supplies both. An
// existing draft is still left untouched, so the proposal's hash never moves under a reader mid-review.
const adoptRuntimeInstall = async (services: Services, tool: string): Promise<"unavailable" | undefined> => {
    const ledger = await services.runtimeInstalls.read();
    const entry = ledger.installs.find((install) => install.tool === tool);
    const step = entry === undefined ? undefined : stepFor(entry);
    const file = entry === undefined ? undefined : draftFileName(entry.tool);
    if (entry === undefined || step === undefined || file === undefined) {
        return "unavailable";
    }
    // Adopting a previously dismissed tool clears its tombstone, or the sweep would fight the requested draft.
    await services.runtimeInstalls.decline([tool], undefined);
    const path = join(draftsDir(services), file);
    if ((await services.files.read(path)) === undefined) {
        await services.files.write(path, draftContent(entry, step));
    }
    return undefined;
};

export const decideRuntimeInstall = async (
    services: Services,
    { tool, decision }: EnvironmentRuntimeDecision,
): Promise<"unavailable" | undefined> => {
    if (decision === "adopt") {
        return adoptRuntimeInstall(services, tool);
    }
    if (decision === "dismiss") {
        await dismissRuntimeInstall(services, tool);
        return undefined;
    }
    await services.runtimeInstalls.decline([tool], undefined);
    return undefined;
};
