import { buildCommand, buildRouteMap, numberParser, type CommandContext } from "@stricli/core";
import { createRecall, parseLine, readLines, type Recall, type SessionMatch, typedPromptOf } from "@intentic/iq-recall";
import { loadConfig } from "../../env.config.js";

const recallFor = (root: string): Recall => {
    const config = loadConfig();
    return createRecall({ root, ...(config.iqClaudeDir !== "" ? { claudeDir: config.iqClaudeDir } : {}) });
};

const rootFromEnv = (): string => {
    const config = loadConfig();
    return config.workspaceRoot === "" ? process.cwd() : config.workspaceRoot;
};

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const collapse = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const ingestCommand = buildCommand({
    docs: { brief: "Index new transcript lines from ~/.claude/projects (incremental, self-managing)" },
    parameters: { flags: {}, positional: { kind: "tuple", parameters: [] } },
    async func(this: CommandContext) {
        const recall = recallFor(rootFromEnv());
        try {
            const stats = await recall.ingest();
            this.process.stdout.write(
                `iq sessions: ${stats.sessions} sessions · ${stats.turns} turns · ${stats.files} files across ${stats.transcripts} transcripts\n`,
            );
        } finally {
            recall.close();
        }
    },
});

const list = buildCommand({
    docs: { brief: "Recent sessions of this workspace, newest first" },
    parameters: {
        flags: {
            days: { kind: "parsed", parse: numberParser, default: "45", brief: "Only sessions active in the last N days" },
            limit: { kind: "parsed", parse: numberParser, default: "50", brief: "Max sessions" },
            json: { kind: "boolean", default: false, brief: "One JSON array" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "Filter by prompt/response/title words", placeholder: "query", optional: true }],
        },
    },
    async func(this: CommandContext, flags: { days: number; limit: number; json: boolean }, query?: string) {
        const recall = recallFor(rootFromEnv());
        try {
            await recall.ingest();
            const sessions = recall.sessions({ days: flags.days, limit: flags.limit, ...(query !== undefined ? { query } : {}) });
            if (flags.json) {
                this.process.stdout.write(`${JSON.stringify(sessions, undefined, 4)}\n`);
            } else {
                for (const session of sessions) {
                    this.process.stdout.write(
                        `${session.sessionId}  ${dateOf(session.lastTs)}  ${session.promptCount} prompts  ${session.title ?? "(untitled)"}\n`,
                    );
                }
            }
            (this.process as { exitCode?: number | string | null }).exitCode = sessions.length > 0 ? 0 : 1;
        } finally {
            recall.close();
        }
    },
});

const files = buildCommand({
    docs: { brief: "Files past sessions touched while working on a topic (frecency × inverse-ubiquity ranked)" },
    parameters: {
        flags: {
            days: { kind: "parsed", parse: numberParser, default: "90", brief: "Only associations from the last N days" },
            limit: { kind: "parsed", parse: numberParser, default: "20", brief: "Max files" },
            json: { kind: "boolean", default: false, brief: "One JSON array" },
        },
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Topic words", placeholder: "query" }] },
    },
    async func(this: CommandContext, flags: { days: number; limit: number; json: boolean }, query: string) {
        const recall = recallFor(rootFromEnv());
        try {
            await recall.ingest();
            const hits = recall.filesForTopic(query, { days: flags.days, limit: flags.limit });
            if (flags.json) {
                this.process.stdout.write(`${JSON.stringify(hits, undefined, 4)}\n`);
            } else {
                for (const hit of hits) {
                    this.process.stdout.write(
                        `${hit.path}  (${hit.sessions} session${hit.sessions === 1 ? "" : "s"}, last ${dateOf(hit.lastTouched)})${hit.sampleTitle === undefined ? "" : ` , ${hit.sampleTitle}`}\n`,
                    );
                }
            }
            (this.process as { exitCode?: number | string | null }).exitCode = hits.length > 0 ? 0 : 1;
        } finally {
            recall.close();
        }
    },
});

const readStdin = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });

// The prompt is "first" when the session transcript doesn't exist yet, or its only typed prompt is the one
// being submitted (the hook may fire before or after claude-code appends it, both orders occur).
const isFirstPrompt = async (transcriptPath: string, prompt: string): Promise<boolean> => {
    let seen = 0;
    try {
        for await (const { json } of readLines(transcriptPath, 0)) {
            const line = parseLine(json);
            if (line === undefined) {
                continue;
            }
            const typed = typedPromptOf(line);
            if (typed === undefined) {
                continue;
            }
            seen += 1;
            if (seen > 1 || typed !== prompt) {
                return false;
            }
        }
    } catch {
        return true;
    }
    return true;
};

const forkCommandOf = (recall: Recall, match: SessionMatch, prompt: string): string => {
    const point = recall.forkPoint(match.sessionId, prompt);
    return `iq sessions fork ${match.sessionId}${point === undefined ? "" : ` --at ${point.turnUuid}`}`;
};

// UserPromptSubmit payload → hookSpecificOutput JSON on a strong first-prompt match, silence otherwise.
// Exported for tests; never throws on malformed input, a broken hook must not block the user's prompt.
export const runHookMatch = async (input: string, write: (chunk: string) => void): Promise<void> => {
    let payload: { session_id?: string; transcript_path?: string; cwd?: string; prompt?: string };
    try {
        payload = JSON.parse(input) as typeof payload;
    } catch {
        return;
    }
    const prompt = payload.prompt ?? "";
    if (prompt === "") {
        return;
    }
    if (payload.transcript_path !== undefined && !(await isFirstPrompt(payload.transcript_path, prompt))) {
        return;
    }
    const config = loadConfig();
    const root = config.workspaceRoot !== "" ? config.workspaceRoot : (payload.cwd ?? process.cwd());
    const recall = recallFor(root);
    try {
        await recall.ingest();
        const matches = recall.match(prompt, payload.session_id === undefined ? {} : { excludeSessionId: payload.session_id });
        const top = matches[0];
        if (top === undefined || !top.strong) {
            return;
        }
        const lead = `A related past session exists: "${top.title ?? top.sessionId}" (${dateOf(top.lastTs)}, ${top.promptCount} prompts). If the user seems to be continuing that work, suggest they fork it instead of rebuilding context: ${forkCommandOf(recall, top, prompt)}`;
        // Same 45-day window as the strong-match gate; the current session never quotes itself.
        const excerpts = recall.grab(prompt, {
            days: 45,
            limit: 3,
            ...(payload.session_id === undefined ? {} : { excludeSessionId: payload.session_id }),
        });
        const fragments = excerpts.map(
            (excerpt) =>
                `- "${excerpt.title ?? excerpt.sessionId}" ${dateOf(excerpt.ts)} · asked: ${cap(collapse(excerpt.prompt), 160)}${excerpt.fragment === "" ? "" : ` · answered: ${cap(collapse(excerpt.fragment), 280)}`}`,
        );
        const context =
            fragments.length === 0
                ? lead
                : [lead, "Excerpts from those sessions (statistical recall, verify against the current code before trusting):", ...fragments].join(
                      "\n",
                  );
        write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })}\n`);
    } finally {
        recall.close();
    }
};

const match = buildCommand({
    docs: { brief: "Rank recent sessions against a prompt; --hook consumes a UserPromptSubmit payload from stdin" },
    parameters: {
        flags: {
            days: { kind: "parsed", parse: numberParser, default: "45", brief: "Only sessions active in the last N days" },
            json: { kind: "boolean", default: false, brief: "One JSON array" },
            hook: { kind: "boolean", default: false, brief: "Read the UserPromptSubmit payload from stdin; emit hook JSON" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "The new session's first prompt", placeholder: "prompt", optional: true }],
        },
    },
    async func(this: CommandContext, flags: { days: number; json: boolean; hook: boolean }, prompt?: string) {
        if (flags.hook) {
            await runHookMatch(await readStdin(), (chunk) => this.process.stdout.write(chunk));
            return;
        }
        if (prompt === undefined) {
            throw new Error("iq sessions match: provide a prompt argument (or --hook with a stdin payload)");
        }
        const recall = recallFor(rootFromEnv());
        try {
            await recall.ingest();
            const matches = recall.match(prompt, { days: flags.days });
            if (flags.json) {
                this.process.stdout.write(`${JSON.stringify(matches, undefined, 4)}\n`);
            } else {
                for (const hit of matches) {
                    this.process.stdout.write(
                        `${hit.score.toFixed(2)}${hit.strong ? " strong" : "       "}  ${hit.sessionId}  ${dateOf(hit.lastTs)}  ${hit.title ?? "(untitled)"}\n`,
                    );
                }
                const top = matches[0];
                if (top?.strong === true) {
                    this.process.stdout.write(`\nfork it: ${forkCommandOf(recall, top, prompt)}\n`);
                }
            }
            (this.process as { exitCode?: number | string | null }).exitCode = matches.length > 0 ? 0 : 1;
        } finally {
            recall.close();
        }
    },
});

const grab = buildCommand({
    docs: { brief: "Ranked conversation excerpts from past sessions for a topic (asked → answered fragments)" },
    parameters: {
        flags: {
            days: { kind: "parsed", parse: numberParser, default: "90", brief: "Only turns from the last N days" },
            limit: { kind: "parsed", parse: numberParser, default: "10", brief: "Max excerpts" },
            budget: { kind: "parsed", parse: numberParser, default: "1500", brief: "Output token budget (est. 4 chars/token)" },
            json: { kind: "boolean", default: false, brief: "One JSON array" },
        },
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Topic words", placeholder: "query" }] },
    },
    async func(this: CommandContext, flags: { days: number; limit: number; budget: number; json: boolean }, query: string) {
        const recall = recallFor(rootFromEnv());
        try {
            await recall.ingest();
            const excerpts = recall.grab(query, { days: flags.days, limit: flags.limit });
            if (flags.json) {
                this.process.stdout.write(`${JSON.stringify(excerpts, undefined, 4)}\n`);
            } else {
                let spent = 0;
                let shown = 0;
                for (const excerpt of excerpts) {
                    const block = [
                        // `×N` marks a prompt that recurs, a scheduled job or a repeated ask. Saying it on the
                        // one row it collapsed to is the point: the alternative is N rows that say it N times.
                        `${excerpt.score.toFixed(2)}  ${excerpt.sessionId}/${excerpt.ordinal}  ${dateOf(excerpt.ts)}  ${excerpt.title ?? "(untitled)"}${excerpt.repeats > 0 ? `  ×${excerpt.repeats + 1}` : ""}`,
                        `    asked: ${cap(collapse(excerpt.prompt), 240)}`,
                        ...(excerpt.fragment === "" ? [] : [`    answered: ${cap(collapse(excerpt.fragment), 480)}`]),
                        // What the session around the hit opened and closed on, so a mid-session match carries
                        // the shape of the conversation it came from rather than only its own sentence.
                        ...(excerpt.bookends === undefined
                            ? []
                            : [
                                  `    session (${excerpt.bookends.turns} turns): opened "${cap(collapse(excerpt.bookends.first), 120)}" → ended "${cap(collapse(excerpt.bookends.last), 120)}"`,
                              ]),
                    ].join("\n");
                    spent += Math.ceil(block.length / 4);
                    // Always show the top hit; past the budget, report the remainder instead of printing it.
                    if (shown > 0 && spent > flags.budget) {
                        this.process.stdout.write(`… ${excerpts.length - shown} more past --budget ${flags.budget}\n`);
                        break;
                    }
                    this.process.stdout.write(`${block}\n`);
                    shown += 1;
                }
                const top = excerpts[0];
                if (top !== undefined) {
                    this.process.stdout.write(`\ncontinue from an excerpt's full context: iq sessions fork ${top.sessionId} --at ${top.ordinal}\n`);
                }
            }
            (this.process as { exitCode?: number | string | null }).exitCode = excerpts.length > 0 ? 0 : 1;
        } finally {
            recall.close();
        }
    },
});

const fork = buildCommand({
    docs: { brief: "Copy a session up to a turn into a fresh session id for `claude --resume`" },
    parameters: {
        flags: {
            at: { kind: "parsed", parse: String, optional: true, brief: "Last included user turn (uuid or ordinal); omit to fork the whole session" },
            dryRun: { kind: "boolean", default: false, brief: "Report what would be forked without writing" },
        },
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Session to fork", placeholder: "sessionId" }] },
    },
    async func(this: CommandContext, flags: { at?: string; dryRun: boolean }, sessionId: string) {
        const recall = recallFor(rootFromEnv());
        try {
            await recall.ingest();
            const result = await recall.fork(sessionId, { ...(flags.at !== undefined ? { at: flags.at } : {}), dryRun: flags.dryRun });
            this.process.stdout.write(
                `${flags.dryRun ? "would fork" : "forked"} ${result.keptLines} lines (${result.droppedLines} dropped) → ${result.sessionId}\n`,
            );
            if (result.staleFiles.length > 0) {
                this.process.stdout.write(
                    `stale since then: re-read before trusting:\n${result.staleFiles.map((file) => `    ${file}`).join("\n")}\n`,
                );
            }
            if (!flags.dryRun) {
                this.process.stdout.write(`resume with: claude --resume ${result.sessionId}\n`);
            }
        } finally {
            recall.close();
        }
    },
});

export const sessionsCommand = buildRouteMap({
    routes: { ingest: ingestCommand, list, files, match, grab, fork },
    docs: { brief: "Session recall, what past sessions touched and said, and forking them mid-point" },
});
