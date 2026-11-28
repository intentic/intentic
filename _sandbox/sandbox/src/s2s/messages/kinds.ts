import type {
    S2sEnvelope,
    S2sEnvelopeHeader,
    S2sPayload,
    S2sPayloadKind,
    S2sPayloadOf,
    S2sRefusalCode,
    SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { ContactRow } from "../contacts/contacts-store.js";

// THE KINDS THE INBOX TAKES (docs/architecture/messages.md, "Receiving", step 8): once admission let an envelope in and
// opened it, the handler registered for its kind stores it and says what to do after the sender is answered. The
// contacts module registers the handshake's kinds and `identity.rotated`, the messages module `message` and `receipt`;
// a later module plugs in `report` and the `task.*` kinds with `register`. A kind nothing registered yet is answered 503
// `unready`, so its sender keeps it and tries again rather than losing it.

// One admitted envelope, opened.
export interface S2sReceived<K extends S2sPayloadKind = S2sPayloadKind> {
    readonly envelope: S2sEnvelope;
    readonly header: S2sEnvelopeHeader;
    readonly payload: S2sPayloadOf<K>;
    // The contact it came from; undefined for a stranger's `contact.request`, the one thing a stranger may send.
    readonly contact: ContactRow | undefined;
    // The sender's document its signature was checked against: the pinned one, or a stranger's as fetched from its address.
    readonly sender: SandboxIdentity;
    readonly receivedAt: number;
}

// What a handler made of it: stored (answered 202, then `after` runs), or refused with a code the sender branches on.
export type S2sKindOutcome =
    | { readonly stored: true; readonly after?: () => Promise<void> }
    | { readonly refused: S2sRefusalCode; readonly error: string };

export type S2sKindHandler<K extends S2sPayloadKind = S2sPayloadKind> = (received: S2sReceived<K>) => Promise<S2sKindOutcome>;

export interface S2sKinds {
    // Registers the one handler for a kind; answers its removal. A second registration for a kind throws.
    readonly register: <K extends S2sPayloadKind>(kind: K, handler: S2sKindHandler<K>) => () => void;
    readonly handlerOf: (kind: S2sPayloadKind) => S2sKindHandler | undefined;
}

const isKind = <K extends S2sPayloadKind>(payload: S2sPayload, kind: K): payload is S2sPayloadOf<K> => payload.kind === kind;

export const createS2sKinds = (): S2sKinds => {
    const handlers = new Map<S2sPayloadKind, S2sKindHandler>();
    return {
        register: (kind, handler) => {
            if (handlers.has(kind)) {
                throw new Error(`s2s: the ${kind} kind already has a handler`);
            }
            handlers.set(kind, async (received) => {
                const { payload } = received;
                // openEnvelope already holds a payload to its header's kind; this says so to the handler's type.
                return isKind(payload, kind)
                    ? handler({ ...received, payload })
                    : { refused: "malformed", error: `a ${payload.kind} payload under a ${kind} header` };
            });
            return () => {
                handlers.delete(kind);
            };
        },
        handlerOf: (kind) => handlers.get(kind),
    };
};
