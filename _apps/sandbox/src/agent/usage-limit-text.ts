import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";

/* A spent Claude allowance surfaces as PROSE — "You've hit your session limit · resets 1:40pm (UTC)" — filed
 * under whatever error category (or none at all) the failing layer happened to pick, so the sentence itself is
 * the one reliable signal. The SDK publishes the exact prefixes those sentences use, which makes matching them
 * classification, not text-sniffing.
 *
 * Shared because the sentence leaks into every place that treats model output as data, and each has to refuse
 * it as such: the stream normalizer (agent.ts, where it becomes the `rate_limit` error code), the one-shot
 * helper (one-shot.ts, where it would otherwise BE the commit subject or session title it was asked for), and
 * the fleet registry (agents-registry.ts, where one that got through must not keep the title it stole). */
export const isUsageLimitText = (text: string): boolean => USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
