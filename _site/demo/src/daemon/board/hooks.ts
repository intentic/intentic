import type { HookRequest, HookRequests } from "@intentic/sandbox-contract/schemas/approvals";
import { refuse } from "@intentic/contract-serve";
import { REVIEW_AGENT_ID } from "../../fixture/fleet";
import { demoQuiet } from "../../mode";
import { STARTED_AT } from "./roster";

// Hook sets a turn found in the workspace's Claude Code settings that nobody has approved in that exact form, as the
// daemon's ledger holds them: the soft-deletes agent's turn found the web repository's formatter hook. Until it is
// approved, turns run with it off. Approving takes it off the list; dismissing keeps it, marked, still approvable.
// Quiet recordings were never interrupted by one, so they hold none.

const PRETTIER_HOOK: HookRequest = {
    digest: `9f2c4e7a1b3d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8`,
    seenAt: STARTED_AT - 26 * 60_000,
    conversationId: REVIEW_AGENT_ID,
    hooks: [
        { source: `project`, event: `PostToolUse`, matcher: `Edit|Write`, type: `command`, run: `$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh` },
        { source: `project`, event: `SessionStart`, type: `command`, run: `pnpm --silent -C web exec tsc --version` },
    ],
    scripts: [{ path: `$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh`, sha256: `4b1e0c9d7a2f3e5b6c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b` }],
};

let requests: HookRequest[] = demoQuiet() ? [] : [PRETTIER_HOOK];

export const hookRequests = (): HookRequests => ({
    // Waiting ones first, then the dismissed, as the daemon orders them.
    requests: requests.toSorted((a, b) => Number(a.dismissed === true) - Number(b.dismissed === true) || b.seenAt - a.seenAt),
});

const named = (digest: string): HookRequest => requests.find((request) => request.digest === digest) ?? refuse(`No hook set waits under that fingerprint.`, 404);

export const approveHooks = (digest: string): void => {
    const set = named(digest);
    requests = requests.filter((request) => request !== set);
};

export const dismissHooks = (digest: string): void => {
    const set = named(digest);
    requests = requests.map((request) => (request === set ? { ...request, dismissed: true } : request));
};
