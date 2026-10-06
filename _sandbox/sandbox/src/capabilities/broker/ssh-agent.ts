import type { Socket } from "node:net";
import { Transform } from "node:stream";
import { AgentProtocol, type ParsedKey } from "ssh2";
import type { CredentialGate } from "../../secrets/gates/credential-gate.js";

// The sandbox's ssh agent: the one place a private SSH key is used, and the agent's half of "use, never hold" for SSH,
// as the credential gateway (broker-gateway.ts) is for HTTP. It speaks OpenSSH's agent protocol, so `ssh`, `scp`,
// `rsync` and git over ssh use it through SSH_AUTH_SOCK with no change, and it answers exactly two requests: which keys
// it holds, and a signature with one of them. Everything else the protocol offers (adding or removing keys, locking,
// extensions) is refused, so nothing on the other end of the socket can load, list out or delete a key. The signature
// is made here, and the agent's process only ever sees the public half and the signature.
//
// Who is asking is the socket, not the request (ssh-agent-sockets.ts): the owner's terminal has one socket and every
// conversation its own, so a conversation's signatures answer to its own gates, cards and ledger rows.

export interface HeldKey {
    readonly alias: string;
    readonly key: ParsedKey;
    // The connected cards whose gate covers this key, checked in order on every signature a conversation asks for.
    readonly cards: readonly string[];
    // Whether a conversation's agent may sign with it at all; the owner's own terminal always may. A git account's key
    // is the owner's only: a turn's git goes through the credential gateway, where that card's rules apply, and a
    // signature here would be a way around them.
    readonly forConversations: boolean;
    // The registry name a conversation's signature is recorded under (`<card>/privateKey`); absent records none.
    readonly ledgerName?: string;
}

export type SshPrincipal = { readonly kind: "owner" } | { readonly kind: "conversation"; readonly conversationId: string | undefined };

// One signature made for a conversation, for the use ledger.
export interface SshSignUse {
    readonly alias: string;
    readonly ledgerName: string;
    readonly conversationId: string | undefined;
    readonly approvedBy?: string;
}

export interface SshAgentDeps {
    // Every key the sandbox holds, read live: a key connected or removed is offered or gone from the next request on.
    readonly keys: () => Promise<readonly HeldKey[]>;
    readonly credentialGate: Pick<CredentialGate, "check">;
    readonly used: (use: SshSignUse) => void;
    readonly warn: (message: string, error?: unknown) => void;
}

// RFC 4251's string: a big-endian length, then the bytes.
const wireString = (bytes: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
};

// One DER INTEGER at `at`: its content bytes, which DER already keeps in the minimal two's complement an SSH mpint is.
const derInteger = (der: Buffer, at: number): { readonly value: Buffer; readonly next: number } | undefined => {
    if (der[at] !== 0x02 || at + 1 >= der.length) {
        return undefined;
    }
    let length = der[at + 1] ?? 0;
    let start = at + 2;
    if ((length & 0x80) !== 0) {
        const bytes = length & 0x7f;
        length = 0;
        for (let index = 0; index < bytes; index += 1) {
            length = length * 256 + (der[start + index] ?? 0);
        }
        start += bytes;
    }
    return start + length > der.length ? undefined : { value: der.subarray(start, start + length), next: start + length };
};

// node signs ECDSA as DER `SEQUENCE { r, s }`; the agent protocol wants `mpint r, mpint s` (RFC 5656 3.1.2).
export const ecdsaWireSignature = (der: Buffer): Buffer | undefined => {
    if (der[0] !== 0x30 || der.length < 2) {
        return undefined;
    }
    const lengthByte = der[1] ?? 0;
    const at = (lengthByte & 0x80) === 0 ? 2 : 2 + (lengthByte & 0x7f);
    const r = derInteger(der, at);
    const s = r === undefined ? undefined : derInteger(der, r.next);
    return r === undefined || s === undefined ? undefined : Buffer.concat([wireString(r.value), wireString(s.value)]);
};

// ssh2's sign hands back an Error instead of throwing; both read as no signature.
const signed = (result: Buffer | Error): Buffer | undefined => (result instanceof Error || result.length === 0 ? undefined : result);

/**
 * The signature blob the agent protocol returns for `data`, in the format the key's type names; the protocol layer
 * prefixes the format name. `hash` is the RSA variant the client asked for (`rsa-sha2-256`/`-512`), absent for the
 * legacy `ssh-rsa`. Undefined for a key type it does not sign with (DSA, retired from OpenSSH).
 */
export const sshSignature = (key: ParsedKey, data: Buffer, hash: string | undefined): Buffer | undefined => {
    if (key.type === "ssh-ed25519") {
        return signed(key.sign(data));
    }
    if (key.type === "ssh-rsa") {
        return signed(key.sign(data, hash ?? "sha1"));
    }
    if (key.type.startsWith("ecdsa-sha2-")) {
        const der = signed(key.sign(data));
        return der === undefined ? undefined : ecdsaWireSignature(der);
    }
    return undefined;
};

const sameKey = (held: ParsedKey, asked: ParsedKey): boolean => held.getPublicSSH().equals(asked.getPublicSSH());

// The two requests ssh2's AgentProtocol answers itself (SSH_AGENTC_REQUEST_IDENTITIES, SSH_AGENTC_SIGN_REQUEST).
const ANSWERED = new Set([11, 13]);
// OpenSSH's own ceiling on one agent message (AGENT_MAX_LEN, authfd.c).
const MAX_MESSAGE = 256 * 1024;

/**
 * The client's messages as AgentProtocol can read them: one it does not answer is cut to its type alone. Its catch-all
 * replies with a failure but never steps past the message's body (ssh2 1.17.0, lib/agent.js), so the body is read as
 * more messages and every reply after it lands one late. OpenSSH 8.9 and later opens each listing with
 * SSH_AGENTC_EXTENSION ("session-bind@openssh.com"), so `ssh` took a failure for the answer to its listing ("agent
 * refused operation") and logged in with no key, while `ssh-add -L`, which sends no extension, worked. Cut short, every
 * such message is still refused, in its turn: a failure is what the protocol asks of an agent without the extension.
 */
export const agentMessages = (): Transform => {
    let pending = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _encoding, done) {
            pending = Buffer.concat([pending, chunk]);
            const read: Buffer[] = [];
            while (pending.length >= 4) {
                const length = pending.readUInt32BE(0);
                if (length === 0 || length > MAX_MESSAGE) {
                    done(new Error(`an agent message of ${String(length)} bytes`));
                    return;
                }
                if (pending.length < 4 + length) {
                    break;
                }
                const type = pending[4] ?? 0;
                read.push(ANSWERED.has(type) ? pending.subarray(0, 4 + length) : Buffer.from([0, 0, 0, 1, type]));
                pending = pending.subarray(4 + length);
            }
            done(null, read.length === 0 ? undefined : Buffer.concat(read));
        },
    });
};

/** Serves one client connection: identities and signatures for `principal`, a failure for anything else. */
export const serveSshAgent = (socket: Socket, principal: SshPrincipal, deps: SshAgentDeps): void => {
    const protocol = new AgentProtocol(false);
    // A card raised for a signature is withdrawn when the ssh waiting on it goes away.
    const gone = new AbortController();
    const close = (): void => {
        gone.abort();
        socket.destroy();
    };
    socket.once("close", () => gone.abort());
    socket.on("error", close);
    protocol.on("error", (error: unknown) => {
        deps.warn("ssh agent: a client sent something that is not the agent protocol; its connection was closed", error);
        close();
    });
    const messages = agentMessages();
    messages.on("error", (error: Error) => {
        deps.warn("ssh agent: a client sent a message no agent reads; its connection was closed", error);
        close();
    });
    socket.pipe(messages).pipe(protocol).pipe(socket);

    const usable = async (): Promise<readonly HeldKey[]> => {
        const keys = await deps.keys();
        return principal.kind === "owner" ? keys : keys.filter((held) => held.forConversations);
    };

    protocol.on("identities", (request) => {
        usable().then(
            (keys) => protocol.getIdentitiesReply(request, keys.map((held) => held.key)),
            (error: unknown) => {
                deps.warn("ssh agent: the held keys could not be read, so none were offered", error);
                protocol.failureReply(request);
            },
        );
    });

    protocol.on("sign", (request, asked, data, options) => {
        const sign = async (): Promise<void> => {
            const held = (await usable()).find((candidate) => sameKey(candidate.key, asked));
            if (held === undefined) {
                protocol.failureReply(request);
                return;
            }
            let approvedBy: string | undefined;
            if (principal.kind === "conversation") {
                // Who: every card answering for the key, through the same gate every other credential exit consults.
                for (const card of held.cards) {
                    const verdict = await deps.credentialGate.check({
                        subject: card,
                        kind: "capability",
                        lane: "ssh",
                        detail: `ssh ${held.alias}`,
                        conversationId: principal.conversationId,
                        signal: gone.signal,
                    });
                    if (!verdict.allow) {
                        protocol.failureReply(request);
                        return;
                    }
                    approvedBy = verdict.approvedBy ?? approvedBy;
                }
            }
            const signature = sshSignature(held.key, data, options.hash);
            if (signature === undefined) {
                protocol.failureReply(request);
                return;
            }
            protocol.signReply(request, signature);
            if (principal.kind === "conversation" && held.ledgerName !== undefined) {
                deps.used({
                    alias: held.alias,
                    ledgerName: held.ledgerName,
                    conversationId: principal.conversationId,
                    ...(approvedBy !== undefined ? { approvedBy } : {}),
                });
            }
        };
        sign().catch((error: unknown) => {
            deps.warn("ssh agent: a signature failed", error);
            protocol.failureReply(request);
        });
    });
};
