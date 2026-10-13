import type { CapabilitySummary } from "@intentic/sandbox-contract";
import { linkedSandboxRowsOf } from "./linkedSandboxRows";

// The Devices board's linked sandboxes: each link card, read off the status its handler last saw over there.

const card = (id: string, status: CapabilitySummary[`status`], config: CapabilitySummary[`config`] = {}): CapabilitySummary => ({
    id,
    kind: `link`,
    status,
    config: { url: `https://sandbox-${id}.sbx.test`, hasToken: true, ...config },
    secrets: [`token`],
});

describe(`linkedSandboxRowsOf`, () => {
    it(`names each by the sandbox's own name, and tells answering, revoked and quiet apart`, () => {
        expect(
            linkedSandboxRowsOf([
                card(`ops`, { state: `active`, detail: `ops: Its tasks wear the persona "On call".` }, { name: `Ops box` }),
                card(`dev`, { state: `error`, code: `token`, detail: `revoked there` }),
                card(`lab`, { state: `pending`, detail: `the other sandbox did not answer` }),
                { id: `rog`, kind: `device`, status: { state: `active` }, config: {}, secrets: [] },
            ]),
        ).toEqual([
            { id: `ops`, name: `Ops box`, state: `online`, tone: `success`, detail: `ops: Its tasks wear the persona "On call".` },
            { id: `dev`, name: `dev`, state: `revoked`, tone: `danger`, detail: `revoked there` },
            { id: `lab`, name: `lab`, state: `quiet`, tone: `neutral`, detail: `the other sandbox did not answer` },
        ]);
    });
});
