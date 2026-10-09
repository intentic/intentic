import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
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
import { cacheProblem } from "./apt-cache-rule.js";
import { AUTO_MARKER, autoDraftedTools, draftContent, draftFileName, named, stepFor } from "./auto-drafts.js";
import { containerBornAtMs, installLive } from "./drift.js";
import { type OverlayBlock, renderBlocks, splitBlocks, uniqueBlocks, withoutRepeats } from "./overlay-blocks.js";
import { privacyPackFragments } from "./privacy-pack.js";
import { statePath } from "../state-paths.js";

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
// undefined when none should exist. Runs on capability add/remove, approve, a privacy policy change, and boot,
// catching drift when a daemon update changes a fragment.
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
            ...(await Promise.all(capabilities.map((capability) => services.environmentSources.capabilityFragments(capability)))).flat(),
            ...(await services.environmentSources.workspaceExtensionFragments()),
            // Helper binaries a connected provider needs, for a base image that doesn't already bake them.
            ...(await services.environmentSources.providerPackFragments()),
            // The privacy shield's readers, while its policy asks for one.
            ...(await privacyPackFragments(services)),
        ]),
    ].toSorted();
    const fragments = services.config.sandbox.vm ? withoutRuntimeDirectives(contributed) : contributed;
    // Once per tool: a section an older release appended a repeat to builds that tool once, not once per copy.
    const custom = withoutRepeats(((await services.files.read(customPath(services))) ?? "").trim());
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

// The tool a draft file is named after, which is also the name of its block once composed.
const draftTool = (file: string): string => file.slice(0, -".Dockerfile".length);

// One pending draft file: the tool it is named after, its steps, and where it sits.
interface DraftFile {
    readonly tool: string;
    readonly body: string;
    readonly path: string;
}

// How a settled draft is remembered: its tool and the hash of its trimmed steps.
const settledKey = (tool: string, body: string): string => `${tool}\u0000${sha256Hex(body.trim())}`;
const settledKeys = async (services: Services): Promise<ReadonlySet<string>> =>
    new Set(((await services.runtimeInstalls.read()).settled ?? []).map((entry) => `${entry.tool}\u0000${entry.hash}`));

const listDrafts = async (services: Services): Promise<DraftFile[]> => {
    const dir = draftsDir(services);
    // A listing that failed throws: read as "no drafts", it would drop the standing proposal.
    const names = ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => name.endsWith(".Dockerfile")).toSorted();
    const drafts = await Promise.all(
        names.map(async (name): Promise<DraftFile> => {
            const path = join(dir, name);
            return { tool: draftTool(name), body: ((await services.files.read(path)) ?? "").trim(), path };
        }),
    );
    return drafts.filter((draft) => draft.body !== "");
};

// The drafts still asking for something. One the owner already answered (approved, removed or declined, the same tool
// with the same steps) is a copy an agent's branch carried back in with its land: it is deleted rather than proposed
// again, since the removal the owner made would otherwise come back with every land.
const pendingDrafts = async (services: Services): Promise<DraftFile[]> => {
    const drafts = await listDrafts(services);
    if (drafts.length === 0) {
        return drafts;
    }
    const settled = await settledKeys(services);
    const pending: DraftFile[] = [];
    for (const draft of drafts) {
        if (settled.has(settledKey(draft.tool, draft.body))) {
            await services.files.remove(draft.path);
            continue;
        }
        pending.push(draft);
    }
    return pending;
};

// Every draft that settles now, remembered so a copy returning with a land asks nothing.
const settleDrafts = async (services: Services, drafts: readonly { readonly tool: string; readonly body: string }[]): Promise<void> => {
    await services.runtimeInstalls.settle(
        drafts.map((draft) => ({ tool: draft.tool, hash: sha256Hex(draft.body.trim()) })),
        Date.now(),
    );
};

const readDrafts = async (services: Services): Promise<string> =>
    (await pendingDrafts(services)).map((draft) => `# ---- ${draft.tool} ----\n${draft.body}`).join("\n\n");

// Composes the proposal from the approved custom section plus every pending draft; carrying custom forward matters
// since approval replaces it wholesale. A draft replaces its tool's block rather than appending a second one (a draft
// file is named by its tool, uniqueBlocks), and drafts that change nothing propose nothing: an agent's branch carrying
// an already-approved draft brings the file back with every land. No drafts ⇒ proposal untouched.
const mergeProposalDrafts = async (services: Services): Promise<void> => {
    const drafts = await readDrafts(services);
    if (drafts === "") {
        return;
    }
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    const approved = uniqueBlocks(splitBlocks(custom));
    // Block by block too: a draft file carrying several tools (a workspace or definition import) keeps one the owner
    // already answered from asking again, though the file as a whole is new.
    const settled = await settledKeys(services);
    const asked = splitBlocks(drafts).filter((block) => !settled.has(settledKey(block.name, block.body)));
    const merged = uniqueBlocks([...approved, ...asked]);
    // An identical draft proposes nothing, even if a previous land brought its file back.
    if (renderBlocks(merged) === renderBlocks(approved)) {
        await services.files.remove(proposalPath(services));
        return;
    }
    await writeComposed(services, proposalPath(services), `${renderBlocks(merged)}\n`);
};

// Two custom sections asking for the same steps, tool for tool, whatever their spacing or repeated blocks.
const sameTools = (left: string, right: string): boolean => renderBlocks(uniqueBlocks(splitBlocks(left))) === renderBlocks(uniqueBlocks(splitBlocks(right)));

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
        // A proposal asking for nothing the approved section lacks is no decision: it raises no "Needs you".
        ...(proposal !== undefined && !sameTools(proposal.content, custom?.content ?? "") ? { proposal } : {}),
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
    const accepted = renderBlocks(uniqueBlocks(splitBlocks(proposal.content)));
    await services.files.write(customPath(services), accepted === "" ? "" : `${accepted}\n`);
    // Drafts are now in the custom section; leaving them would re-propose what the owner just approved, forever, and
    // remembering them keeps the copies an agent's branch still carries from proposing them again on its land.
    await settleDrafts(services, await listDrafts(services));
    await services.files.remove(draftsDir(services));
    await composeEnvironment(services);
    return undefined;
};

// Instructions a draft may carry: the image is built from the daemon's own FROM, and nothing else has a build context.
const DRAFT_LINE = /^\s*(RUN|ENV)\s/i;
const CONTINUATION = /^\s/;

// Why these steps cannot be a draft, or undefined when they can: RUN and ENV lines (with their continuations and comments)
// only, no FROM, no runtime directive.
export const draftProblem = (steps: string): string | undefined => {
    if (invalidProposal(steps)) {
        return "the steps may not contain FROM (the sandbox owns the base image) or an intentic:runtime line";
    }
    const lines = steps.split("\n");
    const stray = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#") && !DRAFT_LINE.test(line) && !CONTINUATION.test(line));
    return stray === undefined ? undefined : `only RUN and ENV lines may be proposed, and "${stray.trim().slice(0, 60)}" is neither`;
};

// Files one tool's steps as a draft on the main tree, where the Environment card and the needs card both read it: an
// agent's own draft would otherwise wait for its conversation to land before anyone could see it.
export const proposeDraft = async (services: Services, tool: string, steps: string): Promise<{ readonly file: string } | { readonly problem: string }> => {
    const file = draftFileName(tool);
    if (file === undefined) {
        return { problem: `"${tool}" cannot name a draft: use letters, digits and dashes` };
    }
    const problem = draftProblem(steps) ?? cacheProblem(steps);
    if (problem !== undefined) {
        return { problem };
    }
    // Asked for on purpose, so an earlier answer to these same steps no longer stands in their way.
    await services.runtimeInstalls.unsettle(draftTool(file), sha256Hex(steps.trim()));
    await services.files.write(join(draftsDir(services), file), `${steps.trim()}\n`);
    return { file };
};

// Whatever drafts remain, as the proposal, or no proposal once none do: a proposal of nothing asks approval for nothing.
const recomposeProposal = async (services: Services): Promise<void> => {
    if ((await readDrafts(services)) === "") {
        await services.files.remove(proposalPath(services));
        return;
    }
    await mergeProposalDrafts(services);
};

// Approves ONE tool's draft into the custom section, leaving every other draft pending: a person answering one agent's
// card approves that agent's steps, not whatever else happens to be waiting. Answers the composed overlay's hash, which
// the running container matches once it has been rebuilt from it.
export const approveDraft = async (services: Services, tool: string): Promise<{ readonly hash: string | undefined } | { readonly problem: string }> => {
    const file = draftFileName(tool);
    const path = file === undefined ? undefined : join(draftsDir(services), file);
    const draft = path === undefined ? undefined : (await services.files.read(path))?.trim();
    if (file === undefined || path === undefined || draft === undefined || draft === "") {
        return { problem: `no draft is waiting for ${tool}` };
    }
    const problem = draftProblem(draft);
    if (problem !== undefined) {
        return { problem };
    }
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    // Named as its file names it, as the proposal drew it (readDrafts): a raw spelling here ("ImageMagick") left the
    // approved block and the settled record under different names, so a removed tool's copy came back with a land.
    const merged = renderBlocks(uniqueBlocks([...splitBlocks(custom), { name: draftTool(file), body: draft }]));
    await writeComposed(services, customPath(services), `${merged}\n`);
    await settleDrafts(services, [{ tool: draftTool(file), body: draft }]);
    await services.files.remove(path);
    await recomposeProposal(services);
    return { hash: await composeEnvironment(services) };
};

// Drops ONE tool's draft; the rest stay pending.
export const rejectDraft = async (services: Services, tool: string): Promise<void> => {
    const file = draftFileName(tool);
    if (file === undefined) {
        return;
    }
    const path = join(draftsDir(services), file);
    const draft = (await services.files.read(path))?.trim();
    if (draft !== undefined && draft !== "") {
        await settleDrafts(services, [{ tool: draftTool(file), body: draft }]);
    }
    await services.files.remove(path);
    await recomposeProposal(services);
};

// One tool's pending draft file, if it has one.
const draftOf = async (services: Services, block: string): Promise<DraftFile | undefined> => {
    const file = draftFileName(block);
    if (file === undefined) {
        return undefined;
    }
    const path = join(draftsDir(services), file);
    const body = ((await services.files.read(path)) ?? "").trim();
    return body === "" ? undefined : { tool: block, body, path };
};

// A tool the daemon drafted from runtime installs is declined as well, or the sweep would draft it again.
const declineAutoDrafted = async (services: Services, blocks: readonly OverlayBlock[]): Promise<void> => {
    const marked = blocks.find((entry) => entry.body.startsWith(`${AUTO_MARKER} `));
    const tool = marked?.body.split("\n", 1)[0]?.slice(AUTO_MARKER.length).trim() ?? "";
    if (tool !== "") {
        await services.runtimeInstalls.decline([tool], Date.now());
    }
};

// A standing proposal that still names the tool: what it asks beyond the section left behind stays up, and one asking
// nothing more (or asking for an empty section, which approving would read as "remove everything") goes.
const proposalWithout = async (services: Services, proposed: readonly OverlayBlock[], block: string, kept: string): Promise<void> => {
    const rest = renderBlocks(proposed.filter((entry) => entry.name !== block));
    if (rest === "" || sameTools(rest, kept)) {
        await services.files.remove(proposalPath(services));
        return;
    }
    await writeComposed(services, proposalPath(services), `${rest}\n`);
};

// Takes one tool out of the environment on the owner's say-so: its approved block, its pending draft and its line in a
// standing proposal. Each is remembered as settled, so a copy an agent's branch still carries does not propose it again
// on the next land. Taking out an approved block changes the overlay, so it waits for a rebuild like any other change;
// the drafts that remain recompose the proposal after.
export const removeFromEnvironment = async (services: Services, block: string): Promise<"missing" | undefined> => {
    const custom = splitBlocks(((await services.files.read(customPath(services))) ?? "").trim());
    const draft = await draftOf(services, block);
    const proposal = await services.files.read(proposalPath(services));
    const proposed = splitBlocks((proposal ?? "").trim());
    const isBlock = (entry: OverlayBlock): boolean => entry.name === block;
    const removed = [...custom.filter(isBlock), ...proposed.filter(isBlock), ...(draft === undefined ? [] : [{ name: block, body: draft.body }])];
    if (removed.length === 0) {
        return "missing";
    }
    // Under the name its draft file would carry too, which is what a copy returning with a land is read by: a block
    // approved before approvals were named by their file keeps its raw spelling.
    const fileNamed = (name: string): string => {
        const file = draftFileName(name);
        return file === undefined ? name : draftTool(file);
    };
    const settledAs = removed.flatMap((entry) => [...new Set([entry.name, fileNamed(entry.name)])].map((tool) => ({ tool, body: entry.body })));
    await settleDrafts(services, settledAs);
    await declineAutoDrafted(services, removed);
    const kept = renderBlocks(uniqueBlocks(custom.filter((entry) => !isBlock(entry))));
    if (custom.some(isBlock)) {
        await services.files.write(customPath(services), kept === "" ? "" : `${kept}\n`);
    }
    if (draft !== undefined) {
        await services.files.remove(draft.path);
    }
    if (proposal !== undefined) {
        await proposalWithout(services, proposed, block, kept);
    }
    await mergeProposalDrafts(services);
    await composeEnvironment(services);
    return undefined;
};

// The overlay this container was built from, as the runner stamped it; empty for a container built with none.
export const appliedEnvironmentHash = (services: Pick<Services, "config">): string => services.config.sandbox.environmentHash;

// Drops the drafts too, or the next read composes the rejected proposal right back. Auto-drafted ones are also
// tombstoned, so the sweep can't just re-earn and recreate them; agent-written ones are simply deleted, free to be
// asked for again.
export const rejectEnvironment = async (services: Services): Promise<void> => {
    const auto = await autoDraftedTools(services);
    if (auto.length > 0) {
        await services.runtimeInstalls.decline(auto, Date.now());
    }
    await settleDrafts(services, await listDrafts(services));
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
    const content = draftContent(entry, step);
    await services.runtimeInstalls.unsettle(draftTool(file), sha256Hex(content.trim()));
    const path = join(draftsDir(services), file);
    if ((await services.files.read(path)) === undefined) {
        await services.files.write(path, content);
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
