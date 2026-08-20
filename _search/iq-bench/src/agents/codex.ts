import { z } from "zod";
import { type AgentAdapter, type AgentRunResult, execAgent, onPath } from "./adapter.js";

// `codex exec --json` JSONL events (experimental surface, parsed best-effort, absent fields stay absent).
const EventSchema = z.looseObject({
    type: z.string(),
    item: z.looseObject({ type: z.string().optional(), text: z.string().optional() }).optional(),
    usage: z
        .looseObject({
            input_tokens: z.number().optional(),
            cached_input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
        })
        .optional(),
});

export const parseCodexStream = (stdout: string): Omit<AgentRunResult, "exitCode" | "raw"> => {
    let answer = "";
    let turns = 0;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let cacheRead: number | undefined;
    for (const line of stdout.split("\n")) {
        if (!line.startsWith("{")) {
            continue;
        }
        let json: unknown;
        try {
            json = JSON.parse(line);
        } catch {
            continue;
        }
        const event = EventSchema.safeParse(json);
        if (!event.success) {
            continue;
        }
        if (event.data.type === "item.completed" && event.data.item?.type === "agent_message" && event.data.item.text !== undefined) {
            answer = event.data.item.text;
        }
        if (event.data.type === "turn.completed") {
            turns += 1;
            const usage = event.data.usage;
            if (usage?.input_tokens !== undefined) {
                tokensIn = (tokensIn ?? 0) + usage.input_tokens;
            }
            if (usage?.output_tokens !== undefined) {
                tokensOut = (tokensOut ?? 0) + usage.output_tokens;
            }
            if (usage?.cached_input_tokens !== undefined) {
                cacheRead = (cacheRead ?? 0) + usage.cached_input_tokens;
            }
        }
    }
    return {
        answer,
        ...(turns > 0 ? { turns } : {}),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    };
};

export const codexAdapter: AgentAdapter = {
    id: "codex",
    // No default, the user's configured codex model (e.g. GPT 5.6 Sol) applies unless --model is passed.
    available: () => onPath("codex"),
    async run(options) {
        // codex has no --max-turns equivalent; the wall-clock timeout is the cap (recorded in run metadata).
        const args = [
            "exec",
            options.prompt,
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            "-C",
            options.cwd,
            ...(options.model !== undefined ? ["--model", options.model] : []),
        ];
        const { stdout, stderr, exitCode } = await execAgent("codex", args, options);
        return { ...parseCodexStream(stdout), exitCode, raw: stdout === "" ? stderr : stdout };
    },
};
