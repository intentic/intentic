import type { SealAnswer } from "@intentic/sandbox-contract/schemas/seal";
import { t } from "@intentic/ui/i18n";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { assertPasskey } from "../../../client/session/passkeySignIn";
import { optimistic } from "../useAgents-provisional";
import { challengeOf } from "../../sandbox/devices/egressFlow";

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

/** The owner has no passkey to sign with: said as the way on (Access ▸ Sign-in), not as a failure. */
export class NoPasskeyError extends Error {
    constructor() {
        super(t(`chat.seal.open.noPasskey`));
    }
}

/**
 * OPENS IT WITHOUT ASKING, the sandbox owner's one door past a seal: the daemon writes the document (its nonce, its expiry,
 * the reason exactly as the author will read it), the owner's passkey signs the sha256 of that text as the network fence's
 * changes are signed (egressFlow.changeToSign), and the signature goes back with the same text. Throws NoPasskeyError
 * when the owner has none, the ceremony's own error when it is cancelled, and the daemon's refusal otherwise.
 */
export const openWithoutAsking = async (id: string, reason: string): Promise<void> => {
    const ceremony = await sandboxRpc.seal.prepareOpen({ id, reason });
    if (ceremony.credentials.length === 0) {
        throw new NoPasskeyError();
    }
    const assertion = await assertPasskey({
        rpId: ceremony.rpId,
        challenge: await challengeOf(ceremony.document),
        timeout: 120_000,
        userVerification: `required`,
        allowCredentials: ceremony.credentials.map((credential) => ({ type: `public-key`, id: credential.id, transports: credential.transports })),
        available: true,
    });
    await optimistic(id, {}, () => sandboxRpc.seal.open({ id, document: ceremony.document, assertion }));
};
