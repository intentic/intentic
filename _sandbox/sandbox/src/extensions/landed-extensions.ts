import { basename } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { type ExtensionManifest, ExtensionManifestSchema, extensionIdOf } from "@intentic/extension-manifest";
import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import { powersDigest } from "../capabilities/extension-inventory/extension-approvals.js";
import { type ExtensionHost, extensionInventory, type PendingExtension } from "../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../composition.js";
import { stateRelPath } from "../state-paths.js";
import { approveAndConverge } from "./extension-approve.js";

/* A land is the owner's yes to the workspace extensions it carries. An extension an agent writes in its own copy reaches
 * the workspace only by a land, which the owner presses or set to happen by itself, so making them approve it again in
 * Extensions asked twice for one decision (2026-11-21). What a land turns on is exactly what it carried: a folder under
 * workspace-extensions/ its delta touched, whose manifest in the workspace declares the powers the landed commit's does.
 * An extension written straight into the workspace, or edited there since, still waits for the Approve press. */

// Repo-relative, as git names the root repository's paths: the root repo IS the workspace.
const WORKSPACE_EXTENSIONS = stateRelPath(".intentic/config/workspace-extensions/");

// The folders under workspace-extensions/ a land's delta touched, by name.
const touchedFolders = async (dir: string, from: string, tip: string, git: GitRunner): Promise<Set<string>> => {
    const { stdout } = await git(dir, ["diff", "--name-only", "-z", "--no-renames", from, tip, "--", `${WORKSPACE_EXTENSIONS}/`]);
    const folders = new Set<string>();
    for (const path of stdout.split("\0")) {
        const folder = path.slice(WORKSPACE_EXTENSIONS.length + 1).split("/")[0];
        if (path.startsWith(`${WORKSPACE_EXTENSIONS}/`) && folder !== undefined && folder !== "") {
            folders.add(folder);
        }
    }
    return folders;
};

// The manifest as the land carried it, read from the landed commit; undefined where it held none that parses.
const manifestAt = async (dir: string, tip: string, folder: string, git: GitRunner): Promise<ExtensionManifest | undefined> => {
    try {
        const { stdout } = await git(dir, ["show", `${tip}:${WORKSPACE_EXTENSIONS}/${folder}/intentic-extension.json`]);
        return ExtensionManifestSchema.parse(JSON.parse(stdout));
    } catch {
        // allow(silent-catch): a commit with no manifest that parses carried no extension to turn on
        return undefined;
    }
};

// The pending workspace extensions a land from `from` to `tip` in the root repository carried, as they stand now.
const carriedExtensions = async (host: ExtensionHost, span: { readonly from: string; readonly tip: string }, git: GitRunner = defaultGit): Promise<PendingExtension[]> => {
    const dir = host.workspace.root;
    const folders = await touchedFolders(dir, span.from, span.tip, git);
    if (folders.size === 0) {
        return [];
    }
    const carried: PendingExtension[] = [];
    for (const extension of (await extensionInventory(host)).pending) {
        const folder = basename(extension.dir);
        if (!folders.has(folder)) {
            continue;
        }
        const landed = await manifestAt(dir, span.tip, folder, git);
        if (landed !== undefined && extensionIdOf(landed) === extension.id && powersDigest(landed) === extension.approval.digest) {
            carried.push(extension);
        }
    }
    return carried;
};

// What the Activity row says: the extension, and the powers it gained by the land.
const turnedOnLine = (extension: PendingExtension, title: string | undefined): string => {
    const by = title === undefined ? "Landing this work" : `Landing "${title}"`;
    const added = extension.approval.powers.added;
    return added.length === 0
        ? `${by} turned on the extension ${extension.id} again, asking for nothing it was not approved for before.`
        : `${by} turned on the extension ${extension.id}, which can: ${added.join("; ")}.`;
};

/** On a land that reached the workspace, approves what it carried and lets it run; says so on the conversation's Activity. */
export const approveLandedExtensions = async (services: Services, event: WorkspaceEvent, git: GitRunner = defaultGit): Promise<PendingExtension[]> => {
    if (event.event !== "agent.landed" || event.outcome !== "landed") {
        return [];
    }
    const from = event.repos.find(({ repo }) => repo === "root")?.from;
    // Read now, while the land that announced itself is what the record holds (project-delivery.ts does the same). A
    // conversation that commits onto branches lands into their checkouts, never the workspace (branch-repos.ts).
    const placement = services.agents.entry(event.agentId)?.placement;
    const intoWorkspace = placement?.kind === "worktree" && (placement.branches?.length ?? 0) === 0;
    const tip = intoWorkspace ? placement.repos.find(({ repo }) => repo === "root")?.landedTip : undefined;
    if (from === undefined || tip === undefined || tip === from) {
        return [];
    }
    const carried = await carriedExtensions(services, { from, tip }, git);
    await approveAndConverge(services, carried);
    for (const extension of carried) {
        await services.activity
            .append({ direction: "system", type: "extension.landed_on", content: turnedOnLine(extension, event.title), conversationId: event.agentId })
            .catch((error: Error) => services.logger.warn({ err: error, id: extension.id }, "landed extensions: the activity row could not be written"));
    }
    return carried;
};

/** Watches lands for the extensions they carry; answers the unsubscribe. */
export const startLandedExtensions = (services: Services): (() => void) =>
    services.events.subscribe("workspace", (event) => {
        void approveLandedExtensions(services, event).catch((error: Error) =>
            // Nothing is lost: the extension waits for the Approve press, as one written straight into the workspace does.
            services.logger.warn({ err: error, agentId: event.agentId }, "landed extensions: could not turn on what the land carried"),
        );
    });
