// The plugin's mod: what the Bash output cleaners saved, drawn in Claude Code (2.1.287 or later). Claude Code loads this
// file in-process, from `modules` in hooks.json, next to the shell hooks that do the cleaning; it only shows their work.
//   - a status entry under the prompt, updated after each Bash call: "Bash trimmed 84% · 1.6M tokens saved · 12 commands";
//   - `/intentic-pane`, the /intentic:stats report in a pane, or as text where nothing draws.
// A mod runs in an environment with no Node, so files and processes go through `$`, and this one file imports nothing:
// the engine's own types (`import type … from 'claude-code'`) are only written once a mod has loaded, so the few members
// used here are declared below instead, which keeps the package's typecheck working on a fresh checkout.
// Limits (code.claude.com/docs/en/plugins/mods/reference): a hook gets 10 s, a prompt.edit hook 50 ms; nothing here hooks
// prompt.edit, and the per-call hook does a string-length sum and one `$.ui.status` call.

// ---- the slice of the mods API this file uses ----------------------------------------------------------------------

interface Element {
    readonly type: string;
}

type Component<P> = (props: P) => Element;

interface Api {
    readonly plugin: { readonly name: string; readonly root: string };
    readonly env: { get(name: string): Promise<string | undefined> };
    readonly fs: {
        read(path: string): Promise<string>;
        exists(path: string): Promise<boolean>;
        list(path: string): Promise<readonly { readonly name: string; readonly kind: string }[]>;
        stat(path: string): Promise<{ readonly mtimeMs: number }>;
    };
    readonly process: { run(argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
    readonly session: { id(): Promise<string>; cwd(): Promise<string>; surfaces(): Promise<readonly string[]> };
    readonly command: { register(spec: { name: string; description: string; argumentHint?: string }): Promise<object> };
    readonly ui: {
        status(text: string | undefined): void;
        open(pane: { id: string; title?: string }): Promise<{ isPlaced: boolean }>;
        close(pane: { id: string }): Promise<void>;
        invalidate(event: "ui.render"): void;
        resolve(e: RenderEvent): {
            Box: Component<{ flexDirection?: "column" | "row"; gap?: number; children?: readonly Element[] }>;
            Text: Component<{ dimColor?: boolean; children?: string }>;
            Markdown: Component<{ text: string }>;
            Button: Component<{ key: string; label: string; hotkey?: string; onPress: () => Promise<void> }>;
        };
    };
}

type Next<E, R> = (e: E) => Promise<R>;
type Hook<E, R> = ($: Api, e: E, next: Next<E, R>) => Promise<R> | R;

interface PostToolUse {
    readonly session_id?: string;
    readonly tool_name?: string;
    readonly tool_response?: BashResponse | string | null;
}
interface PostToolUseResult {
    readonly updatedToolOutput?: BashResponse | string | null;
}
interface CommandRun {
    readonly args: string;
}
interface SessionStart {
    readonly cwd?: string;
}
// A tool's result as Claude Code hands it over; Bash's carries these, and whatever else it carries is left alone.
interface BashResponse {
    readonly stdout?: string | number | boolean | object | null;
    readonly stderr?: string | number | boolean | object | null;
    readonly interrupted?: boolean;
    readonly isImage?: boolean;
    readonly backgroundTaskId?: string | number | null;
}
interface LedgerRow {
    readonly session?: string | number | null;
    readonly rawBytes?: string | number | null;
    readonly emittedBytes?: string | number | null;
}
interface Options {
    readonly output_cleaners?: boolean | string | number | readonly string[];
}

interface RenderEvent {
    readonly surface?: string;
}

interface On {
    (event: "session.start", hook: Hook<SessionStart, SessionStart>): void;
    (event: "classic.PostToolUse", hook: Hook<PostToolUse, PostToolUseResult | undefined>): void;
    (event: "command.run", matcher: { command: string }, hook: Hook<CommandRun, { text?: string }>): void;
    (event: "ui.render", matcher: { component: "Pane"; requestId: string }, hook: Hook<RenderEvent, Element>): void;
}

export type Register = (on: On, options: Options) => void;

// ---- what the cleaners saved: pure helpers, tested without an engine ---------------------------------------------------

export interface Tally {
    readonly commands: number;
    readonly raw: number;
    readonly emitted: number;
}

export const EMPTY: Tally = { commands: 0, raw: 0, emitted: 0 };

export const add = (tally: Tally, raw: number, emitted: number): Tally => ({ commands: tally.commands + 1, raw: tally.raw + raw, emitted: tally.emitted + emitted });

// A ledger row, as @intentic/output-cleaners writes it into filter-stats.jsonl: lengths of the text before and after the
// cleaners, tagged by the plugin's post-bash hook with the project and the session.
export const seedFromLedger = (text: string, session: string): Tally => {
    let tally = EMPTY;
    for (const line of text.split("\n")) {
        // The session id is a substring of its own rows, so most lines are skipped before they are parsed.
        if (!line.includes(session)) {
            continue;
        }
        try {
            // SAFETY: a ledger line is whatever a past hook wrote; each field is checked by type before it is used.
            const row = JSON.parse(line) as LedgerRow;
            if (row.session === session && typeof row.rawBytes === "number" && typeof row.emittedBytes === "number") {
                tally = add(tally, row.rawBytes, row.emittedBytes);
            }
        } catch {
            // A torn or foreign line is not a row; the ledger's own reader skips these the same way.
        }
    }
    return tally;
};

// What the model would have read of a Bash result, which is what post-bash.ts counts as the raw text: stdout, then stderr.
export const textLength = (response: BashResponse | string | null | undefined): number | undefined => {
    if (typeof response !== "object" || response === null) {
        return undefined;
    }
    const { stdout, stderr, interrupted, isImage, backgroundTaskId } = response;
    if (typeof stdout !== "string" || interrupted === true || isImage === true || backgroundTaskId !== undefined) {
        return undefined;
    }
    const err = typeof stderr === "string" ? stderr : "";
    return err === "" ? stdout.length : stdout.length + (stdout === "" || stdout.endsWith("\n") ? 0 : 1) + err.length;
};

export const emittedLength = (result: PostToolUseResult | undefined): number | undefined => {
    return textLength(result?.updatedToolOutput);
};

// Four characters to a token, as the ledger's own summary counts.
const tokens = (length: number): string => {
    const count = Math.round(length / 4);
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 10_000) {
        return `${Math.round(count / 1000)}k`;
    }
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
};

// Nothing until a command has actually been shortened: "0% saved" under every prompt is noise.
export const statusText = (tally: Tally): string | undefined => {
    const saved = tally.raw - tally.emitted;
    if (saved <= 0 || tally.raw === 0) {
        return undefined;
    }
    return `intentic: Bash output trimmed ${Math.round((saved / tally.raw) * 100)}% · ${tokens(saved)} tokens saved over ${tally.commands} ${tally.commands === 1 ? "command" : "commands"}`;
};

// The plugin's data directory, where post-bash.ts keeps the ledger and session-start.ts the switches. A hook gets it as
// CLAUDE_PLUGIN_DATA; a mod is not given it, so it is worked out the way Claude Code does: `plugins/data/<name>-<marketplace>`
// under the config directory, the marketplace read off the plugin's own install path (`plugins/cache/<marketplace>/<name>/<version>`),
// and `<name>-inline` for a plugin loaded from a folder.
export const dataDirOf = (name: string, root: string, env: { data?: string | undefined; config?: string | undefined; home?: string | undefined }): string | undefined => {
    if (env.data !== undefined && env.data !== "") {
        return env.data;
    }
    const config = env.config !== undefined && env.config !== "" ? env.config : env.home !== undefined && env.home !== "" ? `${env.home}/.claude` : undefined;
    if (config === undefined) {
        return undefined;
    }
    const cached = /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]?$/.exec(root);
    const id = `${name}-${cached?.[1] ?? "inline"}`.replace(/[^a-zA-Z0-9_-]/g, "-");
    return `${config.replace(/[\\/]+$/, "")}/plugins/data/${id}`;
};

// ---- the mod ---------------------------------------------------------------------------------------------------------

const PANE = "intentic-savings";
const COMMAND = "intentic-pane";
// A pane's Markdown holds 10,000 characters; the report is a fraction of that, but a project list could grow.
const REPORT_LIMIT = 9000;

// Where this plugin keeps its ledger: the directory Claude Code names for its hooks (see dataDirOf). A plugin read from a
// folder (a marketplace that is a directory) has an install path that says nothing about its marketplace, so when the
// derived directory holds nothing the session-start hook wrote (`options.json`, written every session), the plugin's own
// newest sibling under plugins/data is taken instead.
const dataDir = async ($: Api): Promise<string | undefined> => {
    const derived = dataDirOf($.plugin.name, $.plugin.root, {
        data: await $.env.get("CLAUDE_PLUGIN_DATA"),
        config: await $.env.get("CLAUDE_CONFIG_DIR"),
        home: (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")),
    });
    if (derived === undefined || (await $.fs.exists(`${derived}/options.json`))) {
        return derived;
    }
    const parent = derived.slice(0, derived.lastIndexOf("/"));
    let best = derived;
    let newest = -1;
    try {
        for (const entry of await $.fs.list(parent)) {
            if (entry.kind !== "dir" || !entry.name.startsWith(`${$.plugin.name}-`)) {
                continue;
            }
            const written = await $.fs.stat(`${parent}/${entry.name}/options.json`).then(
                (stat) => stat.mtimeMs,
                () => -1,
            );
            if (written > newest) {
                newest = written;
                best = `${parent}/${entry.name}`;
            }
        }
    } catch {
        // No plugins/data yet: nothing has run, and the derived directory is as good as any.
    }
    return best;
};

// The /intentic:stats report, from the bundle the plugin ships; the same code the skill runs, so the pane and the command
// say the same thing.
const buildReport = async ($: Api, args: string): Promise<string> => {
    const data = await dataDir($);
    if (data === undefined) {
        return "intentic: the plugin's data directory could not be found, so there is no report to show.";
    }
    const argv = ["node", `${$.plugin.root}/dist/stats.mjs`, "--data", data, "--project", await $.session.cwd(), ...(args.trim() === "all" ? ["all"] : [])];
    try {
        const ran = await $.process.run(argv, { timeoutMs: 20_000 });
        return ran.exitCode === 0 ? ran.stdout.slice(0, REPORT_LIMIT) : `intentic: the report failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 300)}`;
    } catch (error) {
        return `intentic: the report needs Node.js 20.11 or later on PATH (${error instanceof Error ? error.message : String(error)}).`;
    }
};

export const register: Register = (on, options) => {
    // The same switch the shell hooks read: off, nothing is cleaned, nothing is ledgered, and there is nothing to show.
    const cleaning = options["output_cleaners"] !== false;
    let tally: Tally = EMPTY;
    let report = "";

    on("session.start", async ($, e, next) => {
        await $.command.register({ name: COMMAND, description: "Show what the intentic plugin saved, in a pane", argumentHint: "[all]" });
        if (cleaning) {
            try {
                const data = await dataDir($);
                const session = await $.session.id();
                // Resumed or reloaded: what this session already saved is in the ledger. A ledger over the 4 MiB a mod may
                // read at once is not an error; the count starts from this point.
                tally = data === undefined ? EMPTY : seedFromLedger(await $.fs.read(`${data}/output/filter-stats.jsonl`), session);
            } catch {
                tally = EMPTY;
            }
            $.ui.status(statusText(tally));
        }
        return next(e);
    });

    if (cleaning) {
        on("classic.PostToolUse", async ($, e, next) => {
            const raw = e.tool_name === "Bash" ? textLength(e.tool_response) : undefined;
            const result = await next(e);
            if (raw !== undefined) {
                // The shell hook answers with the trimmed result, or with nothing when it left the output as it was.
                tally = add(tally, raw, emittedLength(result) ?? raw);
                $.ui.status(statusText(tally));
            }
            return result;
        });
    }

    on("command.run", { command: COMMAND }, async ($, e) => {
        report = await buildReport($, e.args);
        // A plain `-p` run has no surface at all, and `ui.open` would answer "placed" into nothing; a surface that places no
        // panes answers "not placed". Either way the report goes out as the command's own text, which every Claude Code shows.
        const draws = (await $.session.surfaces()).length > 0;
        const opened = draws ? await $.ui.open({ id: PANE, title: "intentic savings" }) : undefined;
        if (opened?.isPlaced === true) {
            $.ui.invalidate("ui.render");
            return {};
        }
        if (opened !== undefined) {
            await $.ui.close({ id: PANE });
        }
        return { text: report };
    });

    on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => {
        const { Box, Text, Markdown, Button } = $.ui.resolve(e);
        return Box({
            flexDirection: "column",
            gap: 1,
            children: [
                report === "" ? Text({ dimColor: true, children: "Run /intentic-pane to fill this." }) : Markdown({ text: report }),
                Button({
                    key: "refresh",
                    label: "Refresh",
                    hotkey: "r",
                    onPress: async () => {
                        report = await buildReport($, "");
                        $.ui.invalidate("ui.render");
                    },
                }),
            ],
        });
    });
};
