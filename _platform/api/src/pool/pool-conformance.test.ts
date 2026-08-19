import { createProvider } from "@intentic-app/example-provider";
import { describe, expect, it } from "vitest";
import { probeService } from "./pool-admission.js";
import { forwardToService } from "./pool-services.js";

/* THE PROVIDER CONTRACT, PROVED FROM BOTH ENDS AT ONCE: the example provider (_platform/example-provider —
 * the reference code a third party copies) driven by the REAL admission probe and the REAL metered forward,
 * in one process. If either side drifts — the probe demanding something the reference does not do, or the
 * reference doing something the forward refuses — this suite is where it surfaces, instead of on a
 * provider's first publish attempt. */

const SECRET = `example-secret`;
const UPSTREAM = `https://svc.example.test/run`;
const NOW = () => new Date(`2026-08-10T12:00:00Z`);

// The probe checks the endpoint resolves to PUBLIC space before spending a call on it; the handler under
// test has no DNS, so resolution is faked public — exactly the seam pool-admission's own tests use.
const publicLookup = (async () => [{ address: `93.184.216.34`, family: 4 }]) as unknown as typeof import("node:dns/promises").lookup;

// The provider as one in-process fetch: what Bun.serve would dispatch to over a socket, without the socket.
const providerFetch = (): typeof fetch => {
    const provider = createProvider({ secret: SECRET, now: NOW });
    return (async (url: string | URL | Request, init?: RequestInit) => provider.fetch(new Request(String(url), init))) as typeof fetch;
};

describe(`the example provider against the platform's own gates`, () => {
    it(`passes the whole admission probe: serves, rejects forgery, rejects replay`, async () => {
        const verdict = await probeService(UPSTREAM, SECRET, `{"query":"a worked example","paceMs":0}`, providerFetch(), NOW, publicLookup);
        expect(verdict.checks).toMatchObject([
            { name: `serves`, passed: true },
            { name: `rejectsForgery`, passed: true },
            { name: `rejectsReplay`, passed: true },
        ]);
        expect(verdict.passed).toBe(true);
    });

    it(`fails the probe's serves check when the sample request is one it will not serve`, async () => {
        // The probe sends the LISTING's sample request — a provider publishing a sample their endpoint breaks
        // on learns it here, before a member ever pays for the discovery.
        const verdict = await probeService(UPSTREAM, SECRET, `{"scenario":"broken","paceMs":0}`, providerFetch(), NOW, publicLookup);
        expect(verdict.passed).toBe(false);
        expect(verdict.checks[0]).toMatchObject({ name: `serves`, passed: false });
    });

    it(`streams a metered run through the real forward, settling served`, async () => {
        const outcome = await forwardToService(UPSTREAM, SECRET, `{"query":"launch on reddit","paceMs":0}`, providerFetch(), NOW);
        expect(outcome.kind).toBe(`stream`);
        if (outcome.kind !== `stream`) {
            return;
        }
        const events: object[] = [];
        let served = false;
        while (true) {
            const next = await outcome.events.next();
            if (next.done) {
                served = next.value;
                break;
            }
            events.push(next.value);
        }
        expect(served).toBe(true);
        expect(events.map((event) => (event as { event: string }).event)).toEqual([`status`, `status`, `result`]);
    });

    it(`settles every scenario the way the ledger expects: paid 4xx, refunded 5xx, refunded broken stream`, async () => {
        const refuse = await forwardToService(UPSTREAM, SECRET, `{"scenario":"refuse"}`, providerFetch(), NOW);
        expect(refuse).toMatchObject({ kind: `answered`, status: 400 });

        const fail = await forwardToService(UPSTREAM, SECRET, `{"scenario":"fail"}`, providerFetch(), NOW);
        expect(fail).toMatchObject({ kind: `failed` });

        const broken = await forwardToService(UPSTREAM, SECRET, `{"scenario":"broken","paceMs":0}`, providerFetch(), NOW);
        expect(broken.kind).toBe(`stream`);
        if (broken.kind !== `stream`) {
            return;
        }
        let served = true;
        while (true) {
            const next = await broken.events.next();
            if (next.done) {
                served = next.value;
                break;
            }
        }
        expect(served).toBe(false);
    });
});
