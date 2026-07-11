import { z } from "zod";
import { type AgentAdapter, type AgentRunResult, execAgent, onPath } from "./adapter.js";

// The final `type: "result"` event of `claude -p --output-format stream-json`.
const ResultEventSchema = z.looseObject({
    type: z.literal("result"),
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
    usage: z
        .looseObject({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
        })
        .optional(),
});

export const parseClaudeStream = (stdout: string): Omit<AgentRunResult, "exitCode" | "raw"> => {
    for (const line of stdout.split("\n").toReversed()) {
        if (!line.startsWith("{")) {
            continue;
        }
        let json: unknown;
        try {
            json = JSON.parse(line);
        } catch {
            continue;
        }
        const event = ResultEventSchema.safeParse(json);
        if (!event.success || event.data.type !== "result") {
            continue;
        }
        const usage = event.data.usage;
        const cacheRead = usage?.cache_read_input_tokens;
        const cacheCreate = usage?.cache_creation_input_tokens;
        return {
            answer: event.data.result ?? "",
            ...(event.data.num_turns !== undefined ? { turns: event.data.num_turns } : {}),
            // input_tokens excludes cache reads/writes — count all prompt-side tokens the model saw.
            ...(usage?.input_tokens !== undefined ? { tokensIn: usage.input_tokens + (cacheRead ?? 0) + (cacheCreate ?? 0) } : {}),
            ...(usage?.output_tokens !== undefined ? { tokensOut: usage.output_tokens } : {}),
            ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
            ...(event.data.total_cost_usd !== undefined ? { costUsd: event.data.total_cost_usd } : {}),
        };
    }
    return { answer: "" };
};

export const claudeAdapter: AgentAdapter = {
    id: "claude",
    defaultModel: "claude-opus-4-8",
    available: () => onPath("claude"),
    async run(options) {
        const permissions =
            process.env["IQ_BENCH_DANGEROUS"] === "1"
                ? ["--dangerously-skip-permissions"]
                : ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Grep,Glob,Edit,Write"];
        const args = [
            "-p",
            options.prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            String(options.maxTurns),
            // Hermeticity: no MCP servers from user/project config, no web/subagent tools — tasks are local and
            // self-contained, and both arms get identical restrictions so the pairing stays clean.
            "--strict-mcp-config",
            "--disallowedTools",
            "WebFetch,WebSearch,Task,ToolSearch,Workflow",
            ...(options.model !== undefined ? ["--model", options.model] : []),
            ...permissions,
        ];
        const { stdout, stderr, exitCode } = await execAgent("claude", args, options);
        return { ...parseClaudeStream(stdout), exitCode, raw: stdout === "" ? stderr : stdout };
    },
};
