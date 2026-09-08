import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentDrift, RuntimeInstall, RuntimeInstallsFile } from "@intentic/sandbox-contract";
import { installLive } from "./drift.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Writes an overlay draft for a runtime install once it earns one; the pipeline downstream (environment.d/, review,
// approval, rebuild) is untouched. A draft needs all three:
// - recurrence: a second distinct session installed it, since one session alone might be an experiment.
// - corroboration: the live container actually has it (drift.ts), since the ledger's own parsing can lie.
// - a mechanical template: only ecosystems whose Dockerfile step follows from the package name alone (apt, cargo,
//   rustup, npm); everything else waits for a person.
// A written draft is frozen (synthesis skips existing files); rejection tombstones the tool so a sweep never recreates
// it.

export const AUTO_MARKER = "# intentic:auto";

// Second distinct session is the earning line; the first install alone might be a one-off.
const MIN_SESSIONS = 2;

interface WorkspaceFiles {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (path: string) => Promise<string | undefined>;
        readonly write: (path: string, content: string) => Promise<void>;
    };
}

// One Dockerfile step per package name; undefined means this kind has no mechanical step and is surfaced instead of
// drafted.
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
        // Mechanical, since skipping it strands a real corroborated install: the browser pack deletes the headless
        // shell, so a workspace needing it reinstalls every container. Its cache is not mounted; the download itself is
        // the payload.
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

// Tool name as filename; environment.d/<tool>.Dockerfile is the key two agents needing the same tool converge on, so it
// must be deterministic.
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

// Same word-boundary test missingBinary uses: a tool name inside a longer word does not count as a match. Exported so
// readEnvironment can apply it too.
export const named = (content: string, tool: string): boolean =>
    new RegExp(`(?:^|[^\\w.@+-])${tool.replace(/[.+]/g, "\\$&")}(?:[^\\w.@+-]|$)`).test(content);

const draftsDirPath = (root: string): string => statePath(root, ".intentic/config/environment.d/");

// Writes a draft for every ledger entry that has earned one; returns the tools drafted, for the sweep's log line.
// Spawn-free (corroboration is just stat calls), so it can run right after the drift probe.
export const synthesizeAutoDrafts = async (deps: WorkspaceFiles, ledger: RuntimeInstallsFile, drift: EnvironmentDrift): Promise<string[]> => {
    // Already-baked or already-approved tools need no draft; both live in these two files.
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
        // An existing draft, this module's or an agent's, is left untouched so the proposal hash stays stable.
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

// Tools named by auto-written drafts on disk, what rejectEnvironment tombstones; agent-written drafts carry no marker
// and are excluded, so only the machine is told to stop repeating itself.
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
