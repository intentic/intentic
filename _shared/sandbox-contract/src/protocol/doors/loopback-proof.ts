import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../../ids/tunnel-ids.js";

/* A DAEMON ON THE LOOPBACK PORT PROVES IT IS THIS SANDBOX'S BEFORE A CREDENTIAL GOES TO IT (2026-11-24). The machine
   agent dials a sandbox at 127.0.0.1:<port derived from its id> when one answers there, and believed any listener whose
   `/health` echoed the id: another account or container on that port took the link token from the first frame and then
   pushed itself a grant. Now the agent sends a random challenge with `/health`, and only a daemon that keeps the digest
   of the credential the agent is about to present can answer it: an HMAC keyed with that digest (an enrollment keeps
   `sha256(token)`, peers/enrollment.ts and desktop-sync.ts), over this sandbox's id and the challenge. The daemon answers
   only on netd's loopback listener, so a stranger on the port cannot borrow an answer through the public tunnel.
   No answer, a wrong one, or a daemon from before this, and the agent dials the public address. Node-only (node:crypto). */

// The query `/health` takes the challenge on, and the answer's field (DaemonHealth `proof`).
export const PROOF_CHALLENGE_PARAM = "proof";
export const PROOF_KEY_PARAM = "proofKey";

// Both are 32 random bytes or an HMAC, in lowercase hex.
export const PROOF_HEX = /^[0-9a-f]{64}$/;

const hmacHex = (key: string, message: string): string => createHmac("sha256", key).update(message).digest("hex");

// The digest a daemon keeps of a credential it issued, and so the one thing both ends hold to key a proof with.
export const credentialDigest = (token: string): string => sha256Hex(token);

// Which credential the challenge is about, said without anything that answers for it: a daemon finds the enrollment by
// it, and a stranger learns nothing it could prove with.
export const proofKeyOf = (digest: string): string => hmacHex(digest, "intentic loopback proof key");

export const loopbackProof = (digest: string, sandboxId: string, challenge: string): string =>
    hmacHex(digest, `intentic loopback proof\n${sandboxId}\n${challenge}`);

// Whether `answer` is the proof this challenge wanted, compared in constant time.
export const provesLoopback = (answer: string, digest: string, sandboxId: string, challenge: string): boolean =>
    PROOF_HEX.test(answer) && timingSafeEqual(Buffer.from(answer), Buffer.from(loopbackProof(digest, sandboxId, challenge)));
