import type { Samples } from "./smoke-daemon.ts";

// The Secrets page's doors (src/daemon/secrets.ts), kept out of smoke-daemon.ts for its length: a throwaway value is
// stored, gated, guarded, typed into a computer and deleted last; a held one is revealed, and a connection's policy is
// set to the gateway it already uses.
// The Passwords reads, the key list and Generate are sampled beside this in samples/secrets.ts.
export const SECRET_SAMPLES: Omit<Samples[`secrets`], `list` | `generate` | `passwords` | `passwordNeeds` | `passwordActivity`> = {
    inventory: undefined,
    reveal: { key: `DATABASE_URL` },
    set: { key: `SMOKE_SECRET`, value: `smoke` },
    setGate: { subject: `SMOKE_SECRET`, kind: `secret`, approvers: [`ada@acme.dev`], scope: `use` },
    gates: undefined,
    removeGate: { subject: `SMOKE_SECRET` },
    setHosts: { subject: `SMOKE_SECRET`, kind: `secret`, guard: true, hosts: [`api.example.com`] },
    hosts: undefined,
    setPrograms: { subject: `SMOKE_SECRET`, programs: [`notepad.exe`], packages: [], anyField: false },
    programs: undefined,
    keyrings: undefined,
    typeInto: { key: `SMOKE_SECRET`, device: `rog`, countdownSeconds: 0 },
    policy: { subject: `github` },
    setPolicy: { subject: `github`, delivery: `gateway` },
    remove: { key: `SMOKE_SECRET` },
    keyringPair: { a: `rog`, b: `omen` },
};
