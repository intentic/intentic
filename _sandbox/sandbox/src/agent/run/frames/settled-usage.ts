import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { readClaudeUsage } from "../../providers/claude/claude-usage.js";
import { fileAccountUsage } from "./frame-effects.js";

// The account's plan-limit pools, re-read once a turn on a stored Claude account has settled, and filed where every
// reading goes (frame-effects.ts fileAccountUsage: the headroom store, whose announce moves every open window's rings).
//
// (2026-10-20) This read used to sit inside the turn's stream, awaited after the SDK's result and yielded as an
// `account_usage` frame. The usage endpoint can take up to its 10 s timeout, and everything behind the turn's settle
// waited on it: the queue's next turn, a child's report to its parent, the land, the spinner. It runs here instead, after
// the turn has settled and never awaited, so the reading still arrives (through headroom's announce rather than the
// turn's own frame) without any user-visible step paying for it.
export interface SettledTurn {
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly request: Pick<AgentRequest, "credential" | "policy">;
    // A stopped turn was not settled by the provider, so there is no new spend to measure.
    readonly aborted: boolean;
}

export const readSettledUsage = (
    deps: Pick<Services, "cliProxy" | "headroom" | "logger">,
    turn: SettledTurn,
    fetchFn: typeof fetch = fetch,
): Promise<void> | undefined => {
    const { credential, policy } = turn.request;
    // Only a stored-account token has pools to read and an account to file them under; a sealed request's caller waits
    // on it to the last frame and is not a turn whose headroom moves the picker.
    if (turn.aborted || turn.account === undefined || credential.kind !== "claude-oauth" || policy.sealed === true) {
        return undefined;
    }
    return fileSettledReading(deps, turn.provider, turn.account, credential.token, fetchFn);
};

// Never rejects: a failed read is its own line, and the turn it measured has already been answered.
const fileSettledReading = async (
    deps: Pick<Services, "cliProxy" | "headroom" | "logger">,
    provider: AgentProvider,
    account: string,
    token: string,
    fetchFn: typeof fetch,
): Promise<void> => {
    try {
        const reading = await readClaudeUsage(token, fetchFn);
        // An empty read files nothing: an empty list would misread as "no limits" (the endpoint refused, or no plan).
        if (reading.windows.length > 0) {
            await fileAccountUsage(deps, provider, account, reading.windows);
        }
    } catch (error) {
        deps.logger.warn({ err: error }, "account usage: the settled turn's re-read failed");
    }
};
