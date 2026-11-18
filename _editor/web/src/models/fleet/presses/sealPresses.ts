import type { SealAnswer } from "@intentic/sandbox-contract/schemas/seal";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { optimistic } from "../useAgents-provisional";

// THE WRITES ON ONE PRIVATE CONVERSATION (sandbox-contract seal.contract.ts). Each answers the conversation's summary as
// it now stands for the caller, which replaces the board's entry (useAgents-provisional.optimistic), so the card, the
// gate and the chat's head all move with the answer rather than with a guess.

/** Makes it private to its author and `readers` (addresses; absent keeps the list it has), or shared again. */
export const setPrivate = (id: string, on: boolean, readers?: readonly string[]): Promise<void> => {
    const body: ProcedureInput<`seal.set`> = { id, private: on };
    if (readers !== undefined) {
        body.readers = [...readers];
    }
    return optimistic(id, {}, () => sandboxRpc.seal.set(body));
};

/** Asks its author to show it to the caller. */
export const askToRead = (id: string): Promise<void> => optimistic(id, {}, () => sandboxRpc.seal.ask({ id }));

/** A reader's answer to someone who asked: for a day, for good, or no. */
export const answerAsk = (id: string, email: string, answer: SealAnswer[`answer`]): Promise<void> =>
    optimistic(id, {}, () => sandboxRpc.seal.answer({ id, email, answer }));

/** The second person's yes or no to an opening without asking that waits on them. */
export const answerOpening = (id: string, open: string, agree: boolean): Promise<void> =>
    optimistic(id, {}, () => sandboxRpc.seal.approveOpen({ id, open, agree }));

/**
 * OPENS IT WITHOUT ASKING, the sandbox owner's one door past a seal: read-only for a day, its author told at once, and the
 * reason kept on the conversation for good. Throws the daemon's refusal.
 */
export const openWithoutAsking = (id: string, reason: string): Promise<void> => optimistic(id, {}, () => sandboxRpc.seal.open({ id, reason }));
