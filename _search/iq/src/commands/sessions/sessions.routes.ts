import { buildCommand, buildRouteMap, numberParser, type CommandContext } from "@stricli/core";
import { createRecall, parseLine, readLines, type Recall, type SessionMatch, typedPromptOf } from "@intentic/iq-recall";
import { loadConfig } from "../../env.config.js";

const recallFor = (root: string): Recall => {
    const config = loadConfig();
    return createRecall({
        root,
        ...(config.iqClaudeDir !== "" ? { claudeDir: config.iqClaudeDir } : {}),
        ...(config.iqHistoryRoot !== "" ? { historyRoot: config.iqHistoryRoot } : {}),
    });
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
                    /* WHAT NAMES THE ROW. A session an agent turn produced belongs to a conversation, and the
                     * conversation's own id and title are what a reader can act on — `agents show <id>` takes
                     * exactly that id. Without the join every agent-run row printed a bare uuid and the word
                     * "(untitled)", which is how one spelling of a conversation stopped leading to the other. */
                    const named =
                        session.conversation === undefined
                            ? (session.title ?? "(untitled)")
                            : `${session.conversation.id}${session.conversation.title === undefined ? "" : ` · ${session.conversation.title}`}`;
                    this.process.stdout.write(`${session.sessionId}  ${dateOf(session.lastTs)}  ${session.promptCount} prompts  ${named}\n`);
                }
                /* The breadcrumb, printed where the confusion happens rather than as a standing line in a
                 * prompt: someone reading this list is one step from wanting the conversation behind a row,
                 * and this is the verb that answers it whole. */
                if (sessions.some((session) => session.conversation !== undefined)) {
                    this.process.stdout.write("conversations: agents show <id> · agents ls · agents find '<text>'\n");
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

/* WHAT THIS HOOK MAY SPEND, given that it stands between the user pressing enter and the model reading their
 * prompt. Nothing here is worth a visible pause: a recall that arrives late is worth less than no recall.
 *
 * Both numbers sit under the 10s the hook is configured with in plugin/hooks/hooks.json, because being killed
 * at that ceiling is the failure this replaces — over one day it happened on 21 of 43 prompts, each one costing
 * the full ten seconds and delivering nothing. Staying inside our own budget means the outer timeout becomes
 * what it should be, a backstop nobody reaches. */
const INGEST_BUDGET_MS = 2_500;
const HOOK_BUDGET_MS = 5_000;

// Resolves to `undefined` if `work` has not finished in time. The work itself is left running: it is a SQLite
// write we would rather see finish than abort, and the process exits either way.
const withinBudget = async <T>(budgetMs: number, work: Promise<T>): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
        timer.unref();
    });
    try {
        return await Promise.race([work, expiry]);
    } finally {
        clearTimeout(timer);
    }
};

interface HookPayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    prompt?: string;
}

// A payload worth answering, or nothing. Malformed input, an empty prompt and a prompt that is not the
// session's first all come back the same way: this hook's only failure mode may be silence.
const hookPayloadOf = async (input: string): Promise<HookPayload | undefined> => {
    let payload: HookPayload;
    try {
        payload = JSON.parse(input) as HookPayload;
    } catch {
        return undefined;
    }
    const prompt = payload.prompt ?? "";
    if (prompt === "") {
        return undefined;
    }
    if (payload.transcript_path !== undefined && !(await isFirstPrompt(payload.transcript_path, prompt))) {
        return undefined;
    }
    return payload;
};

// UserPromptSubmit payload → hookSpecificOutput JSON on a strong first-prompt match, silence otherwise.
// Exported for tests; never throws on malformed input, a broken hook must not block the user's prompt.
export const runHookMatch = async (input: string, write: (chunk: string) => void): Promise<void> => {
    const payload = await hookPayloadOf(input);
    if (payload === undefined) {
        return;
    }
    const prompt = payload.prompt ?? "";
    const config = loadConfig();
    const root = config.workspaceRoot !== "" ? config.workspaceRoot : (payload.cwd ?? process.cwd());
    const recall = recallFor(root);
    const deadline = Date.now() + HOOK_BUDGET_MS;
    try {
        // A stale index still answers: matching is the point, indexing is upkeep, and the SessionStart hook
        // already backgrounds an unbudgeted `iq sessions ingest` to do the rest.
        await withinBudget(INGEST_BUDGET_MS, recall.ingest({ budgetMs: INGEST_BUDGET_MS }));
        if (Date.now() >= deadline) {
            return;
        }
        const matches = recall.match(prompt, payload.session_id === undefined ? {} : { excludeSessionId: payload.session_id });
        const top = matches[0];
        if (top === undefined || !top.strong) {
            return;
        }
        /* THE EXCERPTS ARE THE PAYLOAD; the fork is an aside. This lead used to open by instructing the model to
         * "suggest they fork it instead of rebuilding context", which is advice about an action only the user
         * can take, addressed to the party who cannot take it: offered on 22 prompts in one day and acted on
         * zero times, while the excerpts underneath it were read and used. So the recall leads, and the fork
         * command rides along as something to mention if the work really is a continuation. */
        const lead = `Related past session "${top.title ?? top.sessionId}" (${dateOf(top.lastTs)}, ${top.promptCount} prompts). Use what follows as background. If this prompt is genuinely continuing that work, you can tell the user they may resume it with \`${forkCommandOf(recall, top, prompt)}\` rather than rebuilding the context here.`;
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
