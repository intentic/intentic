import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentDrift, RuntimeInstall, RuntimeInstallsFile } from "@intentic/sandbox-contract";
import { installLive } from "./drift.js";
import { statePath } from "../workspace/state-paths.js";

/* THE AUTO-DRAFTER: the daemon writing the overlay draft the model was told to write and, six cargo-xwin
 * reinstalls later, demonstrably never did.
 *
 * The draft pipeline downstream is untouched: a file lands in .intentic/config/environment.d/, the daemon folds
 * it into the one proposal the owner reviews, approval bakes it, a rebuild applies it. All this module decides
 * is WHEN a runtime install has earned a draft, and it demands three things at once:
 *
 *   RECURRENCE — a second distinct session installed it. One session is an experiment; two is a habit, and by
 *   the transcript record habits run to eight sessions before a person notices. The ledger survives container
 *   recreates, so "again, in a fresh container" is exactly what the count measures.
 *
 *   CORROBORATION — the live container actually has it (drift.ts). The ledger is command parsing and command
 *   parsing lies: an install inside `docker run` mutates a different filesystem, a failed install mutates
 *   nothing. What was never really installed here is never proposed.
 *
 *   A MECHANICAL TEMPLATE — only ecosystems whose Dockerfile step follows from the package name alone are
 *   drafted (apt, cargo, rustup targets, npm globals). A pip package is a routing decision (Debian package or
 *   venv), a curl|sh replay could embed anything its command line carried; those surface on the Environment
 *   card as recurring installs and wait for a person. Secrets never enter a draft by construction: templates
 *   take the TOOL NAME, never the recorded command — commands appear only in the comment, and the harness
 *   already masked any stored credential to its {{secret:…}} reference before the ledger saw them.
 *
 * A draft, once written, is FROZEN: synthesis skips existing files, so the proposal's hash does not chase the
 * recurrence count while the owner is reading it. Rejection tombstones the tool in the ledger (declinedAt) —
 * without that the next sweep would recreate the rejected draft, forever. An agent hand-writing a draft for a
 * declined tool remains free to: the tombstone gates only this module. */

export const AUTO_MARKER = "# intentic:auto";

// A second distinct session is the earning line. The first install is free — it might be a one-off — and
// waiting for a third would just re-run more of the waste this exists to end.
const MIN_SESSIONS = 2;

interface WorkspaceFiles {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (path: string) => Promise<string | undefined>;
        readonly write: (path: string, content: string) => Promise<void>;
    };
}

/* One Dockerfile step from a package name, per the overlay house rules (the environment skill's): apt carries
 * both cache mounts and keeps the lists, npm mounts its cache, cargo pins with --locked. Undefined = this kind
 * has no mechanical step and is surfaced instead of drafted. */
export const stepFor = (entry: Pick<RuntimeInstall, "tool" | "kind">): string | undefined => {
    switch (entry.kind) {
        case "apt":
            return (
                `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n` +
                `    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n` +
                `    apt-get update \\\n` +
                `    && apt-get install -y --no-install-recommends ${entry.tool}`
            );
        case "cargo":
            return `RUN cargo install --locked ${entry.tool}`;
        case "rustup-target":
            return `RUN rustup target add ${entry.tool}`;
        case "npm":
            return `RUN --mount=type=cache,target=/root/.npm \\\n    npm install -g ${entry.tool}`;
        /* A PLAYWRIGHT BROWSER IS MECHANICAL, and leaving it out is what stranded `chromium-headless-shell` on
         * the Environment card for a week: recorded in two sessions, present in the container, corroborated,
         * and unfixable because nothing downstream could write its step. The gap is not incidental — the
         * browser pack DELETES the headless shell (`rm -rf .../chromium_headless_shell-*`, browser.Dockerfile),
         * because the daemon's own tools launch full headed Chromium, so a workspace whose e2e suite wants the
         * shell reinstalls it every single container. That is precisely the loop the ledger exists to close.
         *
         * The ms-playwright cache is deliberately NOT mounted, for the reason the pack states: the browser is
         * the payload, and a mounted cache is never committed to a layer. Only the npm side is cached. */
        case "playwright":
            return (
                `# The browser cache is deliberately not mounted: the download IS the payload and has to land in\n` +
                `# a layer. Pin the playwright version to whatever resolves this browser for your tests.\n` +
                `RUN --mount=type=cache,target=/root/.npm \\\n` +
                `    npx --yes playwright install --with-deps ${entry.tool}`
            );
        default:
            return undefined;
    }
};

// The tool as a filename: environment.d/<tool>.Dockerfile is also the convergence key two agents needing the
// same tool meet on, so the mapping must be deterministic and boring.
export const draftFileName = (tool: string): string | undefined => {
    const name = tool
        .toLowerCase()
        .replace(/[^a-z0-9._@+-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .replace(/-+$/, "");
    return name === "" ? undefined : `${name}.Dockerfile`;
};

const date = (at: number): string => new Date(at).toISOString().slice(0, 10);

export const draftContent = (entry: RuntimeInstall, step: string): string => {
    const times = entry.sessions.length === 2 ? "twice" : `in ${entry.sessions.length} sessions`;
    const command = entry.commands.at(-1);
    return (
        `${AUTO_MARKER} ${entry.tool}\n` +
        `# ${entry.tool} — installed at runtime ${times} (first ${date(entry.firstAt)}, last ${date(entry.lastAt)}) and\n` +
        `# lost on every container recreate. Drafted by the daemon from the runtime-install ledger; last installed by:\n${
            command === undefined ? "" : `#   ${command.replaceAll("\n", " ")}\n`
        }# Approve to bake it into the image; reject to stop it being proposed.\n${step}\n`
    );
};

// The same boundary class missingBinary uses: a tool name appearing INSIDE a longer word is not that tool.
// Exported because readEnvironment applies the same test to keep already-baked tools off the recurring list.
export const named = (content: string, tool: string): boolean =>
    new RegExp(`(?:^|[^\\w.@+-])${tool.replace(/[.+]/g, "\\$&")}(?:[^\\w.@+-]|$)`).test(content);

const draftsDirPath = (root: string): string => statePath(root, ".intentic/config/environment.d/");

/* Write a draft for every ledger entry that has earned one. Returns the tools drafted this pass, for the
 * sweep's log line. Spawn-free given the drift snapshot — corroboration is stats against known paths — so the
 * sweep can run it right after the probe with nothing between them. */
export const synthesizeAutoDrafts = async (deps: WorkspaceFiles, ledger: RuntimeInstallsFile, drift: EnvironmentDrift): Promise<string[]> => {
    // Already-baked and already-approved tools need no draft; both live in these two files by composition.
    const custom = (await deps.files.read(statePath(deps.workspace.root, ".intentic/config/environment.custom.Dockerfile"))) ?? "";
    const approved = (await deps.files.read(statePath(deps.workspace.root, ".intentic/local/environment.approved.Dockerfile"))) ?? "";
    const drafted: string[] = [];
    for (const entry of ledger.installs) {
        const file = draftFileName(entry.tool);
        const step = stepFor(entry);
        if (file === undefined || step === undefined || entry.sessions.length < MIN_SESSIONS || entry.declinedAt !== undefined) {
            continue;
        }
        if (named(custom, entry.tool) || named(approved, entry.tool)) {
            continue;
        }
        const path = join(draftsDirPath(deps.workspace.root), file);
        // An existing draft — this module's from an earlier pass, or an agent's own — is left exactly as it is:
        // frozen content is what keeps the proposal hash stable under the owner's eyes.
        if ((await deps.files.read(path)) !== undefined) {
            continue;
        }
        if (!(await installLive(entry, drift))) {
            continue;
        }
        await deps.files.write(path, draftContent(entry, step));
        drafted.push(entry.tool);
    }
    return drafted;
};

// The tools named by auto-written drafts currently on disk — what rejectEnvironment tombstones. Agent-written
// drafts carry no marker and are deliberately not returned: rejecting those keeps today's meaning (the agent
// may simply ask again); only the machine is told to stop repeating itself.
export const autoDraftedTools = async (deps: WorkspaceFiles): Promise<string[]> => {
    const dir = draftsDirPath(deps.workspace.root);
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".Dockerfile"));
    const tools = await Promise.all(
        names.map(async (name) => {
            const content = (await deps.files.read(join(dir, name))) ?? "";
            const first = content.split("\n", 1)[0] ?? "";
            return first.startsWith(AUTO_MARKER) ? first.slice(AUTO_MARKER.length).trim() : undefined;
        }),
    );
    return tools.filter((tool): tool is string => tool !== undefined && tool !== "");
};
