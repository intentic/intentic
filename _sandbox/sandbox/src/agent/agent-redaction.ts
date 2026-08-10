import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

/* MASKING WHAT THE AGENT READS, not only what it runs.
 *
 * bin/agent-output-filter masks the output of a Bash command, and for a long time that was the whole of it — so
 * whether a stored credential reached the model depended on HOW it was fetched. `cat` of a config file came
 * back masked; opening the same file with Read, matching it with Grep, or pulling it through an MCP tool did
 * not. The rule anyone would state out loud ("the model is never shown a credential this sandbox stores") was
 * true of one lane and not of the others, and nothing in the transcript distinguishes them.
 *
 * This closes it at the seam every lane shares. PostToolUse fires for every tool the model calls and
 * `updatedToolOutput` replaces the result before it is sent, so masking becomes a property of the
 * CONVERSATION rather than of the terminal.
 *
 * ONLY THE VALUES THIS SANDBOX HOLDS, deliberately — not the name heuristics that also run in the terminal
 * lane. Those infer a credential from the identifier beside it, and their whole failure history is on source
 * code: `oauthToken === undefined` rewritten mid-comparison, a JSON body broken at `"cacheReadTokens":26170149`.
 * A Read of a source file is exactly the input they get wrong, and unlike a shell dump it is text the model has
 * to reason about precisely. Value masking cannot make that mistake — it replaces strings this sandbox actually
 * stores and nothing else — and it is the half that is COMPLETE for what is stored, under any field name a
 * connector invents. The name patterns stay where they were measured.
 *
 * Bash is covered here too, though its own filter already masks it: with cleaning switched off (the raw
 * baseline) that filter does not run at all, and this is then the only thing between a credential and the
 * transcript. Masking twice costs a scan and changes nothing.
 */

// Same floor as the terminal filter's value masking. A shorter string is not distinctive enough to blank on
// sight — masking an 8-character value would black out ordinary output that merely coincides with it.
const MIN_LENGTH = 12;
const MASK = "***";

/* A credential can span lines (an ssh private key, a WireGuard conf) and a tool result is JSON, so the whole
 * value rarely survives as one run of text — each line is registered as its own target instead. Longest first,
 * so a value that contains another is masked whole rather than leaving its tail behind. */
export const maskTargets = (values: readonly string[]): readonly string[] =>
    [...new Set(values.flatMap((value) => value.split("\n")).map((value) => value.trim()))]
        .filter((value) => value.length >= MIN_LENGTH)
        .toSorted((a, b) => b.length - a.length);

const maskString = (text: string, targets: readonly string[]): string =>
    targets.reduce((masked, target) => (masked.includes(target) ? masked.split(target).join(MASK) : masked), text);

/* A tool result is JSON of a shape that belongs to the tool — a string for Bash, `{ file: { content } }` for
 * Read, a content array for an MCP server — so this walks it rather than knowing any of them. Keys are left
 * alone: a key is a field NAME, and blanking those would corrupt the structure without hiding a secret.
 *
 * Returns the SAME reference when nothing matched, which is how the hook tells "unchanged" from "rewritten"
 * without re-comparing a large result — and what keeps the overwhelmingly common case (no credential anywhere
 * in the output) from allocating a copy of it.
 */
export const maskDeep = (value: unknown, targets: readonly string[]): unknown => {
    if (typeof value === "string") {
        const masked = maskString(value, targets);
        return masked === value ? value : masked;
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => maskDeep(item, targets));
        return items.some((item, index) => item !== value[index]) ? items : value;
    }
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const entries = Object.entries(source).map(([key, item]) => [key, maskDeep(item, targets)] as const);
        return entries.some(([key, item]) => item !== source[key]) ? Object.fromEntries(entries) : value;
    }
    return value;
};

export const redactionHooks = (values: () => Promise<readonly string[]>): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    /* No matcher, so every tool — including the ones nobody has written yet. A tool list here would be a list
     * of the tools somebody remembered, which is the exact shape of the gap this exists to close. */
    PostToolUse: [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PostToolUse") {
                        return {};
                    }
                    // Guarded whole: an unreadable vault is a reason to leave a result alone, never to fail the
                    // tool call that produced it.
                    try {
                        const targets = maskTargets(await values());
                        if (targets.length === 0) {
                            return {};
                        }
                        const masked = maskDeep(input.tool_response, targets);
                        return masked === input.tool_response
                            ? {}
                            : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: masked } };
                    } catch {
                        return {};
                    }
                },
            ],
        },
    ],
});
