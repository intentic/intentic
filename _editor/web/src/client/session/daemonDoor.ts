import { type ProofMethod, ProofMethodSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// WHICH PROOFS A DAEMON OPENS A SESSION FOR, read off its unauthenticated /health before any sign-in, since the route list
// arrives only after one. `signIn.proofs` is read here, loosely, rather than through the contract's DaemonHealthReading
// (which predates the field): a daemon of any age answers, and one from before email sign-in says nothing, which means
// Google (and the owner ticket on a hosted machine), never "everything".

// Only the one field, each entry kept only when it names a proof this editor knows, so a newer daemon's proof is not
// mistaken for one of these and an older one's odd answer reads as silence.
const SignInReadingSchema = z.object({
    sandboxId: z.string().optional().catch(undefined),
    signIn: z
        .object({ proofs: z.array(z.unknown()).catch([]) })
        .optional()
        .catch(undefined),
});

export interface DaemonDoor {
    // Whether a daemon answered at all (and, given an id to expect, the right one).
    readonly answers: boolean;
    // The proofs it lists; undefined for a daemon that predates the field, or one that did not answer.
    readonly proofs: readonly ProofMethod[] | undefined;
}

const SILENT: DaemonDoor = { answers: false, proofs: undefined };

// Only the call form this module makes, as in endpoint.ts.
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Generous, as the tunnel probe is: a slow first answer through a tunnel is still an answer.
const DOOR_BUDGET_MS = 5000;

// The same identity check `healthAnswers` makes (endpoint.ts), with the proofs beside it. Every failure is a daemon that
// did not answer: there is nothing to sign in to then, and no sign-in is raised for it.
export const readDaemonDoor = async (base: string, expectedSandboxId: string | undefined, fetchImpl: FetchLike = fetch): Promise<DaemonDoor> => {
    try {
        const response = await fetchImpl(`${base}/health`, { cache: `no-store`, signal: AbortSignal.timeout(DOOR_BUDGET_MS) });
        if (!response.ok) {
            return SILENT;
        }
        const reading = SignInReadingSchema.safeParse(await response.json());
        if (!reading.success || (expectedSandboxId !== undefined && reading.data.sandboxId !== expectedSandboxId)) {
            return SILENT;
        }
        const listed = reading.data.signIn?.proofs;
        return {
            answers: true,
            proofs: listed?.flatMap((entry) => {
                const proof = ProofMethodSchema.safeParse(entry);
                return proof.success ? [proof.data] : [];
            }),
        };
    } catch {
        // allow(silent-catch): DNS, TLS, CORS, a dead tunnel and a body that is not JSON all mean nothing answered here.
        return SILENT;
    }
};

// Whether this daemon takes the platform's identity assertion: it says so, or it is too old to.
export const takesEmailProof = (door: DaemonDoor): boolean => door.proofs?.includes(`email`) === true;
