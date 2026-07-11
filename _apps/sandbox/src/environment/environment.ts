import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Environment } from "@intentic/sandbox-contract";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";

// The overlay Dockerfile extending the sandbox image. The approved file is DAEMON-COMPOSED from three parts:
// the pinned FROM, the enabled capabilities' code-versioned fragments (see CapabilityHandler.fragment), and the
// owner-approved custom section. The agent writes the proposal (custom-section content only — no FROM, no
// runtime directives) with its normal file tools; the owner-gated approve route stores it as the custom file
// and recomposes. The container can't rebuild itself (no docker socket) — an outside executor (scripts/
// rebuild.sh or the workspace provider) verifies the approved content against the hash pinned in the rebuild
// command, builds, and recreates with SANDBOX_ENVIRONMENT_HASH stamped. Status is derived, never stored.

export const proposalPath = (services: Services): string => join(services.workspace.root, ".intentic", "environment.Dockerfile");
export const approvedPath = (services: Services): string => join(services.workspace.root, ".intentic", "environment.approved.Dockerfile");
export const customPath = (services: Services): string => join(services.workspace.root, ".intentic", "environment.custom.Dockerfile");

export const BASE_IMAGE = "registry.gitlab.com/radarsu/intentic/sandbox:stable";

export const environmentHash = (content: string): string => createHash("sha256").update(content).digest("hex");

// The composed overlay must extend the official sandbox image — the first instruction is pinned so an approved
// overlay can't swap the base for an arbitrary image. Held by construction in composeEnvironment; rebuild.sh
// re-checks it belt-and-braces.
export const hasValidBase = (content: string): boolean => {
    const first = content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
    return first !== undefined && /^FROM registry\.gitlab\.com\/radarsu\/intentic\/sandbox:\S+$/.test(first);
};

// A proposal is custom-section content only: the daemon owns the base pin (no FROM) and runtime directives are
// reserved for capability fragments (a proposal can't smuggle container privileges).
const invalidProposal = (content: string): boolean =>
    content.split("\n").some((line) => /^\s*from\s/i.test(line)) || content.includes("intentic:runtime");

const HEADER =
    "# Composed by the intentic sandbox daemon — do not edit by hand.\n" +
    "# Capability fragments are daemon-owned; the custom section mirrors .intentic/environment.custom.Dockerfile.";
const CUSTOM_MARKER = "# ---- custom (owner-approved) ----";

// Regenerate the approved (composed) overlay from the capability manifest + the custom file. Returns the
// composed hash, or undefined when no overlay should exist. Called on capability add/remove, approve, and boot
// (boot converges fragment drift: a daemon update that changes a fragment flips the derived state to "pending
// rebuild" with no new state). ponytail: races the store's read-modify-write under concurrent adds — a stale
// compose self-heals on the next capability event or boot.
export const composeEnvironment = async (services: Services): Promise<string | undefined> => {
    const capabilities = await services.capabilities.list();
    const fragments = [
        ...new Set(
            capabilities
                .map((capability) => registry[capability.kind].fragment?.(capability.config)?.trim())
                .filter((fragment): fragment is string => fragment !== undefined),
        ),
    ].toSorted();
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    if (fragments.length === 0 && custom === "") {
        if (services.config.sandbox.environmentHash === "") {
            await services.files.remove(approvedPath(services));
            return undefined;
        }
        // The running container was built from an overlay that now has nothing left in it: keep a bare overlay
        // so the owner has a hash-pinned rebuild path back to stock.
        const bare = `${HEADER}\n\nFROM ${BASE_IMAGE}\n`;
        await services.files.write(approvedPath(services), bare);
        return environmentHash(bare);
    }
    const sections = [HEADER, `FROM ${BASE_IMAGE}`, ...fragments, ...(custom === "" ? [] : [CUSTOM_MARKER, custom])];
    const content = `${sections.join("\n\n")}\n`;
    await services.files.write(approvedPath(services), content);
    return environmentHash(content);
};

const fileState = async (services: Services, path: string): Promise<{ content: string; hash: string } | undefined> => {
    const content = await services.files.read(path);
    return content === undefined ? undefined : { content, hash: environmentHash(content) };
};

export const readEnvironment = async (services: Services): Promise<Environment> => {
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

// Store the proposal as the custom section and recompose — only when its content still hashes to what the
// owner reviewed (`mismatch` kills the TOCTOU where the agent swaps content after review) and it carries no
// FROM/runtime-directive lines. An empty proposal clears the custom section.
export const approveEnvironment = async (services: Services, hash: string): Promise<"missing" | "mismatch" | "invalid" | undefined> => {
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
    await composeEnvironment(services);
    return undefined;
};

export const rejectEnvironment = async (services: Services): Promise<void> => {
    await services.files.remove(proposalPath(services));
};
