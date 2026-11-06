import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { withGitCallerPart } from "@intentic/base/git";

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

type HookSet = Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>;

// The name each callback's git is filed under, given where its set joins the turn's list (namedHooks). Held beside the
// callbacks rather than on them, since the SDK's matcher has no field for it.
const hookNames = new WeakMap<HookCallback, string>();

/** The same set, every callback in it known by `name` (a short word the code spells: never an id or a path), so the git
 *  it runs is counted as `turn.hook.<event>:<name>`. A callback already named, closer to where it was written, keeps its
 *  own name. */
export const namedHooks = <S extends HookSet>(name: string, set: S): S => {
    for (const matchers of Object.values(set)) {
        for (const hook of (matchers ?? []).flatMap((matcher) => matcher.hooks)) {
            if (!hookNames.has(hook)) {
                hookNames.set(hook, name);
            }
        }
    }
    return set;
};

/** One callback known by `name`, for a set whose callbacks do different work (agent-diagnostics.ts). */
export const namedHook = (name: string, hook: HookCallback): HookCallback => {
    hookNames.set(hook, name);
    return hook;
};

// Every git a callback runs is filed under its event and name inside the turn's own entry (`http agent.run ›
// turn.hook.PostToolUse:main-catch-up`): under the turn's label alone, every hook of every tool call read as the turn.
const timed = (event: HookEvent, matcher: string, at: number, hook: HookCallback, record: HookTimer): HookCallback => {
    const name = hookNames.get(hook);
    const part = name === undefined ? `turn.hook.${event}` : `turn.hook.${event}:${name}`;
    return (input, toolUseId, options) =>
        withGitCallerPart(part, async () => {
            const from = performance.now();
            try {
                return await hook(input, toolUseId, options);
            } finally {
                record(event, performance.now() - from, { matcher, at, tool: toolOf(input) });
            }
        });
};

/** The same hooks, each reporting how long it took to `record` and filing its git under its name; the hooks themselves
 *  when nothing records. */
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
