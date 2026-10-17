import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";

// Each harness's own reviewer, by the name its `/` list publishes: Claude Code's `code-review`, Codex's and OpenCode's
// `review`. Their findings come back as the chat's review card (events/review.ts).
const REVIEW_COMMANDS: readonly string[] = [`code-review`, `review`];

export const isReviewCommand = (command: AgentCommand): boolean => REVIEW_COMMANDS.includes(command.name);

export const reviewCommandOf = (commands: readonly AgentCommand[]): string | undefined =>
    REVIEW_COMMANDS.find((name) => commands.some((command) => command.name === name));
