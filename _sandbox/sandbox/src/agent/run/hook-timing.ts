import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

// Every hook callback a turn answers, timed, so a slow one reaches perf.jsonl as `hook.<event>` (system/resources/
// perf.ts) instead of only as the minutes a tool call spent waiting on it. Measured before this existed: a PreToolUse
// hook parked on an approval card ran out the CLI's ten minutes 45 times, and the per-edit checks cost about an hour a
// week, and neither showed in any log the daemon kept.

// Which hook it was: the event's matcher, its place in the turn's merged list, and the tool it ran for.
export interface HookTiming {
    readonly matcher: string;
    readonly at: number;
    readonly tool: string | undefined;
}

export type HookTimer = (event: HookEvent, ms: number, timing: HookTiming) => void;

const toolOf = (input: Parameters<HookCallback>[0]): string | undefined => ("tool_name" in input ? input.tool_name : undefined);

const timed =
    (event: HookEvent, matcher: string, at: number, hook: HookCallback, record: HookTimer): HookCallback =>
    async (input, toolUseId, options) => {
        const from = performance.now();
        try {
            return await hook(input, toolUseId, options);
        } finally {
            record(event, performance.now() - from, { matcher, at, tool: toolOf(input) });
        }
    };

/** The same hooks, each reporting how long it took to `record`; the hooks themselves when nothing records. */
export const timedHooks = (
    hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
    record: HookTimer | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (record === undefined) {
        return hooks;
    }
    const wrapped: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
    for (const [event, matchers] of Object.entries(hooks) as [HookEvent, HookCallbackMatcher[]][]) {
        wrapped[event] = matchers.map((matcher, at) => ({
            ...matcher,
            hooks: matcher.hooks.map((hook) => timed(event, matcher.matcher ?? "*", at, hook, record)),
        }));
    }
    return wrapped;
};
