import { type ResolvedAddress, speaksS2s, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import type { S2sRefusalCode, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";

// A DOCUMENT A SANDBOX POSTED ABOUT ITSELF, CONFIRMED (docs/architecture/messages.md, "Two ways to make one"): what every
// door that files a contact from an old credential's word does before it pins a key, the handshake's own rule. A report
// pass's introduction (account-routing/messages/contact-bootstrap.routes.ts), a link's upgrade (links/upgrade/) and a route
// pairing's (account-routing/messages/pairing-upgrade.ts) each trust their credential to say WHICH sandbox asks, never
// which key it holds: the key is the one its own address serves.

export interface ConfirmRefusal {
    readonly refused: string;
    readonly status: 400 | 403 | 503;
    readonly code: S2sRefusalCode;
}

const refusal = (status: ConfirmRefusal["status"], code: S2sRefusalCode, refused: string): ConfirmRefusal => ({ refused, status, code });

/** The posted document's own problem: it does not verify, does not speak s2s/1, or is this sandbox's own. */
export const postedDocumentProblem = (document: SandboxIdentity, ours: SandboxIdentity): ConfirmRefusal | undefined => {
    const check = verifyIdentity(document);
    if (!check.ok) {
        return refusal(400, "malformed", `that identity does not verify: ${check.reason}`);
    }
    if (!speaksS2s(document)) {
        return refusal(400, "malformed", "that identity does not speak s2s/1");
    }
    return document.fingerprint === ours.fingerprint ? refusal(400, "malformed", "that is this sandbox") : undefined;
};

/**
 * The document as its own address serves it, with the same key: what is pinned. An address that does not answer is
 * "try later", as for a handshake; one that serves another key is refused.
 */
export const confirmAtAddress = async (
    resolve: (address: string) => Promise<ResolvedAddress>,
    document: SandboxIdentity,
): Promise<{ readonly address: string; readonly document: SandboxIdentity } | ConfirmRefusal> => {
    const resolved = await resolve(document.host);
    if (!resolved.ok) {
        const transient = resolved.code === "unreachable" || resolved.code === "dns";
        return transient ? refusal(503, "unready", `${document.host} could not be confirmed: ${resolved.message}`) : refusal(403, "unconfirmed", resolved.message);
    }
    if (resolved.document.fingerprint !== document.fingerprint) {
        return refusal(403, "unconfirmed", `${document.host} serves key ${resolved.document.fingerprint}, not ${document.fingerprint}`);
    }
    return { address: resolved.address, document: resolved.document };
};
