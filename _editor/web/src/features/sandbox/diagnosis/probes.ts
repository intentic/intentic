import { edgeVerdictOf, EDGE_VERDICT_HEADER, parseVitals, type SandboxVitals, VITALS_PATH } from "@intentic/sandbox-contract";
import type { FrontProbe } from "./diagnose";

// THE PROBES a diagnosis is made of, each bounded and each safe to run against a sandbox that is down, busy or gone.
// They never carry a credential: the vitals route is the front's own and public, and the second probe is opaque. What
// each outcome means is decided by `frontProbeOf`, pure, so the reading is tested without a network.

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Well inside the connection watchdog, and far above what the front needs: it answers vitals without asking its daemon.
export const VITALS_TIMEOUT_MS = 4000;
// The opaque probe only asks "does anything answer this address"; the edge answers at once when it holds no tunnel.
const REACH_TIMEOUT_MS = 6000;

// How one fetch ended, reduced to what the reading needs.
export type Settled =
    // `vitals` is the body read as the front's vitals, undefined for any other body.
    | { readonly kind: "response"; readonly status: number; readonly verdict: string | null; readonly vitals: SandboxVitals | undefined }
    | { readonly kind: "timeout" }
    // The fetch rejected without a response: no route, DNS, TLS, or a response CORS kept from this page.
    | { readonly kind: "error" };

// The opaque reach probe: `answered` means SOMETHING at that address answered, the edge or the sandbox, which rules out
// this browser's own network as the fault.
export type Reach = "answered" | "timeout" | "error";

// A fetch cut off by its own deadline (or aborted) rejects with a DOMException; anything else it rejects with is the
// network's refusal.
const timedOut = (rejection: DOMException | Error | string | undefined): boolean =>
    rejection instanceof DOMException && (rejection.name === `TimeoutError` || rejection.name === `AbortError`);

const readVitals = async (response: Response): Promise<SandboxVitals | undefined> => {
    try {
        return parseVitals(await response.json());
    } catch {
        return undefined;
    }
};

export const settle = async (run: () => Promise<Response>): Promise<Settled> => {
    try {
        const response = await run();
        const verdict = response.headers.get(EDGE_VERDICT_HEADER);
        const vitals = response.status === 200 ? await readVitals(response) : undefined;
        return { kind: `response`, status: response.status, verdict, vitals };
    } catch (error) {
        return timedOut(error instanceof DOMException || error instanceof Error ? error : undefined) ? { kind: `timeout` } : { kind: `error` };
    }
};

const reach = async (url: string, fetchImpl: FetchLike): Promise<Reach> => {
    try {
        await fetchImpl(url, { mode: `no-cors`, cache: `no-store`, signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
        return `answered`;
    } catch (error) {
        return timedOut(error instanceof DOMException || error instanceof Error ? error : undefined) ? `timeout` : `error`;
    }
};

// What the two probes of the sandbox's address establish, together. The readable one decides whenever it can; the
// opaque one only says whether an unreadable failure was this browser's network or a response it may not read.
export const frontProbeOf = (vitals: Settled, reached: Reach): FrontProbe => {
    if (vitals.kind === `response`) {
        const verdict = edgeVerdictOf(vitals.verdict);
        if (verdict !== undefined) {
            return { kind: `edge`, verdict };
        }
        if (vitals.vitals !== undefined) {
            return { kind: `vitals`, vitals: vitals.vitals };
        }
        // The front's own "daemon is restarting"; any other answer came from behind the edge, from a sandbox that is up.
        return vitals.status === 503 ? { kind: `restarting` } : { kind: `answered` };
    }
    if (vitals.kind === `timeout`) {
        return { kind: `silent` };
    }
    // Unreadable. If the opaque probe got through, something there answered in a way this page may not read (an older
    // front's refusal carries no CORS header), which only a running container does.
    if (reached === `answered`) {
        return { kind: `answered` };
    }
    return reached === `timeout` ? { kind: `silent` } : { kind: `unreachable` };
};

// Both probes at once, so the reading costs the slower budget rather than the sum.
export const probeFront = async (daemonUrl: string, fetchImpl: FetchLike = fetch): Promise<FrontProbe> => {
    const base = daemonUrl.replace(/\/+$/, ``);
    const [vitals, reached] = await Promise.all([
        settle(() => fetchImpl(`${base}${VITALS_PATH}`, { cache: `no-store`, signal: AbortSignal.timeout(VITALS_TIMEOUT_MS) })),
        reach(`${base}/health`, fetchImpl),
    ]);
    return frontProbeOf(vitals, reached);
};
