import type { SubagentSession, TranscriptSubagent } from "@intentic/sandbox-contract";

// A subagent as the card of the call that started it shows it, whichever mechanism started it: what its turn recorded,
// brought up to date by the roster while the roster still holds it. A spawned subagent outlives the turn that started it,
// so without the roster its card would stop at whatever it was doing when that turn ended.

const LIVE: ReadonlySet<TranscriptSubagent["status"]> = new Set([`pending`, `running`, `blocked`, `paused`]);

export interface SubagentView {
    // Its own id: what the roster and `wait` call it, and a spawned one's conversation id.
    readonly id: string;
    readonly subagent: TranscriptSubagent;
    // Working, on the word of something that can still vouch for it: the turn streaming it, or the roster. A record
    // frozen when its turn ended is not working, whatever it last said.
    readonly working: boolean;
}

// The roster's newer word on everything a card draws; its id and kind are the card's own and never move.
const latest = (session: SubagentSession): Partial<TranscriptSubagent> =>
    Object.fromEntries(
        Object.entries({
            agentType: session.agentType,
            description: session.description,
            model: session.model,
            provider: session.provider,
            background: session.background,
            status: session.status,
            tokens: session.tokens,
            toolUses: session.toolUses,
            lastTool: session.lastTool,
            summary: session.summary,
            error: session.error,
            verification: session.verification,
        }).filter(([, value]) => value !== undefined),
    );

/** What a card shows of the subagent its call started; undefined for a call that started none. */
export const subagentView = (
    cardId: string,
    recorded: TranscriptSubagent | undefined,
    roster: ((id: string) => SubagentSession | undefined) | undefined,
    turnLive: boolean,
): SubagentView | undefined => {
    if (recorded === undefined) {
        return undefined;
    }
    const id = recorded.id ?? cardId;
    const now = roster?.(id);
    const subagent = now === undefined ? recorded : { ...recorded, ...latest(now) };
    return { id, subagent, working: LIVE.has(subagent.status) && (turnLive || now !== undefined) };
};
