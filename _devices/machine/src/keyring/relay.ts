import { askKeyring, keyringPaths, KeyringUnavailable, type KeyringRequest, type KeyringResponse } from "@intentic/keyring";
import type {
    KeyringCopies,
    KeyringInboxItem,
    KeyringInboxResult,
    KeyringRefusalCode,
    KeyringReleaseResult,
    KeyringShares,
    KeyringSyncDeliverResultSchema,
    KeyringSyncDeliverSchema,
    KeyringSyncOutboxSchema,
    KeyringSyncPairResultSchema,
    KeyringSyncPairSchema,
    KeyringSyncState,
    KeyringTypeInput,
    KeyringTypeResult,
    SignedKeyringGrant,
} from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";

// The sync schemas' types, which the contract exports as schemas only.
type SyncPair = z.infer<typeof KeyringSyncPairSchema>;
type SyncPairResult = z.infer<typeof KeyringSyncPairResultSchema>;
type SyncOutbox = z.infer<typeof KeyringSyncOutboxSchema>;
type SyncDeliver = z.infer<typeof KeyringSyncDeliverSchema>;
type SyncDeliverResult = z.infer<typeof KeyringSyncDeliverResultSchema>;

// THE keyring* PROCEDURES, RELAYED. A sandbox reaches intentic-keyring only through this machine, and this machine only
// carries: each call goes to the keyring's local pipe as one request and its answer comes back as the contract's output.
// The machine reads nothing in between: a grant is checked by the keyring against the sandbox's own signing key, and a
// value rides sealed to whoever the grant names. What the machine adds is the one thing only it knows, which link the
// call came in on: `shares` and `copies` are asked for that sandbox, and an inbox item naming any other is refused here.
//
// Nothing in a request or an answer is logged or audited: sealed boxes are ciphertext, but a grant carries what the use
// is for (the command's start, the site), and the keyring keeps its own record of every decision.

// The link a call came in on, and where the keyring answers (its pipe, or a test's socket).
export interface KeyringLink {
    readonly sandboxUrl: string;
    readonly address?: string | undefined;
}

const addressOf = (link: KeyringLink): string => link.address ?? keyringPaths().address;

// A refusal the contract can carry, from this machine rather than the keyring.
interface Refused {
    readonly ok: false;
    readonly code: KeyringRefusalCode;
    readonly refusal: string;
}

const noKeyring = (error: KeyringUnavailable): Refused => ({ ok: false, code: "no-keyring", refusal: `No keyring answers on this computer: ${error.message}.` });

// One request, with a missing keyring as its own outcome rather than a throw: what each procedure makes of "no keyring"
// differs (a refusal, an empty answer, an error), and a fault that is not that one still throws.
const ask = async <R extends KeyringRequest>(link: KeyringLink, request: R): Promise<KeyringResponse<R["op"]> | KeyringUnavailable> => {
    try {
        return await askKeyring({ address: addressOf(link) }, request);
    } catch (error) {
        if (error instanceof KeyringUnavailable) {
            return error;
        }
        throw error;
    }
};

// For the procedures whose output has no room for a refusal: the keyring's own no, said as an error the daemon reads
// rather than an empty answer it would act on. `data.code` is the keyring's refusal code.
const refusedAsError = (answer: Refused): ORPCError<"SERVICE_UNAVAILABLE", { code: KeyringRefusalCode }> =>
    new ORPCError("SERVICE_UNAVAILABLE", { message: answer.refusal, data: { code: answer.code } });

// Two hosts for one sandbox read the same: a trailing slash or a letter's case must not turn the sandbox's own item away.
const sameSandbox = (a: string, b: string): boolean => {
    const left = URL.parse(a);
    const right = URL.parse(b);
    return left !== null && right !== null && left.origin === right.origin && left.pathname.replace(/\/+$/u, "") === right.pathname.replace(/\/+$/u, "");
};

// The keyring's state and what is shared with this sandbox. A keyring that is not there, or not set up, is a reason in
// words beside an empty list, never a failure: the sandbox shows it on the device's card.
export const keyringShares = async (link: KeyringLink): Promise<KeyringShares> => {
    const [state, shares] = await Promise.all([ask(link, { op: "state" }), ask(link, { op: "shares", sandbox: link.sandboxUrl })]);
    if (state instanceof KeyringUnavailable) {
        return { pointers: [], reason: noKeyring(state).refusal };
    }
    if (!state.ok) {
        return { pointers: [], reason: state.refusal };
    }
    if (!state.setUp) {
        return { pointers: [], reason: "The keyring on this computer is installed but not set up yet: `intentic-machine keyring setup` on it sets it up." };
    }
    if (shares instanceof KeyringUnavailable) {
        return { keyring: state.state, pointers: [], reason: noKeyring(shares).refusal };
    }
    if (!shares.ok) {
        return { keyring: state.state, pointers: [], reason: shares.refusal };
    }
    return { keyring: state.state, pointers: shares.pointers };
};

export const keyringRelease = async (link: KeyringLink, grant: SignedKeyringGrant): Promise<KeyringReleaseResult> => {
    const answer = await ask(link, { op: "release", grant });
    return answer instanceof KeyringUnavailable ? noKeyring(answer) : answer;
};

export const keyringType = async (link: KeyringLink, input: KeyringTypeInput): Promise<KeyringTypeResult> => {
    const answer = await ask(link, { op: "type", input });
    return answer instanceof KeyringUnavailable ? noKeyring(answer) : answer;
};

// An item says which sandbox it came from, and is shared with that sandbox once taken in: only the sandbox on this
// link may name itself, or one sandbox could leave a value in the keyring shared with another.
export const keyringInbox = async (link: KeyringLink, item: KeyringInboxItem): Promise<KeyringInboxResult> => {
    if (!sameSandbox(item.sandbox, link.sandboxUrl)) {
        return {
            ok: false,
            code: "not-shared",
            refusal: `This item names ${item.sandbox} as where it came from, but it arrived from ${link.sandboxUrl}: a sandbox can only send a value to be kept for itself.`,
        };
    }
    const answer = await ask(link, { op: "inbox", item });
    return answer instanceof KeyringUnavailable ? noKeyring(answer) : answer;
};

// An empty list where there is no keyring: nothing to refresh. A keyring that refuses (locked, say) is an error instead,
// so the sandbox keeps the copies it has rather than reading the refusal as "none".
export const keyringCopies = async (link: KeyringLink): Promise<KeyringCopies> => {
    const answer = await ask(link, { op: "copies", sandbox: link.sandboxUrl });
    if (answer instanceof KeyringUnavailable) {
        return { copies: [] };
    }
    if (!answer.ok) {
        throw refusedAsError(answer);
    }
    return { copies: answer.copies };
};

// The one answer with nothing empty to give: no keyring has no sync key, so it is an error saying so.
export const keyringSyncState = async (link: KeyringLink): Promise<KeyringSyncState> => {
    const answer = await ask(link, { op: "sync-state" });
    if (answer instanceof KeyringUnavailable) {
        throw refusedAsError(noKeyring(answer));
    }
    if (!answer.ok) {
        throw refusedAsError(answer);
    }
    return answer.sync;
};

export const keyringSyncPair = async (link: KeyringLink, pair: SyncPair): Promise<SyncPairResult> => {
    const answer = await ask(link, { op: "sync-pair", pair });
    return answer instanceof KeyringUnavailable ? noKeyring(answer) : answer;
};

export const keyringSyncOutbox = async (link: KeyringLink): Promise<SyncOutbox> => {
    const answer = await ask(link, { op: "sync-outbox" });
    if (answer instanceof KeyringUnavailable) {
        return { items: [] };
    }
    if (!answer.ok) {
        throw refusedAsError(answer);
    }
    return { items: answer.items };
};

export const keyringSyncDeliver = async (link: KeyringLink, deliver: SyncDeliver): Promise<SyncDeliverResult> => {
    const answer = await ask(link, { op: "sync-deliver", deliver });
    if (answer instanceof KeyringUnavailable) {
        return { accepted: 0 };
    }
    if (!answer.ok) {
        throw refusedAsError(answer);
    }
    return { accepted: answer.accepted };
};

