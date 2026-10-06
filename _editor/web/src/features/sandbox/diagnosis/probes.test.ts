import type { SandboxVitals } from "@intentic/sandbox-contract";
import { netdProbeOf, probeNetd, type Settled } from "./probes";

// What the two probes of a sandbox's address establish. The readable one decides whenever it can; the opaque one only
// says whether an unreadable failure was this browser's network.

const response = (status: number, over: Partial<Extract<Settled, { kind: "response" }>> = {}): Settled => ({
    kind: `response`,
    status,
    verdict: null,
    vitals: undefined,
    ...over,
});

const VITALS: SandboxVitals = { node: `up`, lagMs: 4200, restarts: 0, uptimeS: 90, pressure: { cpu: 91.5, memory: 3, io: 0 } };

describe(`netdProbeOf`, () => {
    it(`reads netd's vitals`, () => {
        expect(netdProbeOf(response(200, { vitals: VITALS }), `answered`)).toEqual({ kind: `vitals`, vitals: VITALS });
    });

    it(`takes the edge's verdict over anything else the response says`, () => {
        expect(netdProbeOf(response(502, { verdict: `no-tunnel` }), `answered`)).toEqual({ kind: `edge`, verdict: `no-tunnel` });
        // A 502 from something that isn't ours carries no verdict and is not read as one.
        expect(netdProbeOf(response(502, { verdict: `teapot` }), `answered`)).toEqual({ kind: `answered` });
    });

    it(`reads netd's own 503 as a restart, and any other answer as a container that is up`, () => {
        expect(netdProbeOf(response(503), `answered`)).toEqual({ kind: `restarting` });
        expect(netdProbeOf(response(404), `answered`)).toEqual({ kind: `answered` });
        // An older sandbox answering 200 with something that is not vitals.
        expect(netdProbeOf(response(200), `answered`)).toEqual({ kind: `answered` });
    });

    it(`calls a probe that ran out of time silent`, () => {
        expect(netdProbeOf({ kind: `timeout` }, `timeout`)).toEqual({ kind: `silent` });
    });

    it(`tells an unreadable answer from a network that reaches nothing`, () => {
        expect(netdProbeOf({ kind: `error` }, `answered`)).toEqual({ kind: `answered` });
        expect(netdProbeOf({ kind: `error` }, `timeout`)).toEqual({ kind: `silent` });
        expect(netdProbeOf({ kind: `error` }, `error`)).toEqual({ kind: `unreachable` });
    });
});

describe(`probeNetd`, () => {
    it(`asks the vitals route and the health route of the address it is given, with no credential`, async () => {
        const asked: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            asked.push({ url: String(url), init });
            return new Response(JSON.stringify(VITALS), { status: 200, headers: { "content-type": `application/json` } });
        };
        expect(await probeNetd(`https://sandbox-3c469e9d6c58.sbx.intentic.dev/`, fetchImpl)).toEqual({ kind: `vitals`, vitals: VITALS });
        expect(asked.map((each) => each.url).toSorted()).toEqual([
            `https://sandbox-3c469e9d6c58.sbx.intentic.dev/health`,
            `https://sandbox-3c469e9d6c58.sbx.intentic.dev/system/vitals`,
        ]);
        expect(asked.find((each) => each.url.endsWith(`/health`))?.init?.mode).toBe(`no-cors`);
        expect(asked.every((each) => each.init?.credentials === undefined && each.init?.headers === undefined)).toBe(true);
    });

    it(`reads a fetch that throws as this browser's network when the opaque probe fails too`, async () => {
        const fetchImpl = async (): Promise<Response> => {
            throw new TypeError(`Failed to fetch`);
        };
        expect(await probeNetd(`https://sandbox-3c469e9d6c58.sbx.intentic.dev`, fetchImpl)).toEqual({ kind: `unreachable` });
    });
});
