import type {
    CredentialGate,
    CredentialGateKind,
    CredentialPolicy,
    CredentialPolicySet,
    SecretHostGuard,
    SecretInventoryEntry,
    SecretProgramGuard,
} from "@intentic/sandbox-contract/schemas/secrets";

type BrokerRule = CredentialPolicy[`rules`][number];

// The Secrets page's store: values the owner keeps, the connections' own credentials, and the rules on each (who
// releases it, where it may go, what it may be typed into, how a connection hands it over), so every state an open
// secret can show is reachable and every editor on it saves for real, for this page load.

const HOUR = 3_600_000;

const values = new Map<string, string>([
    [`DATABASE_URL`, `postgres://shop:hunter2@db.internal:5432/shop`],
    [`SENTRY_DSN`, `https://o1.ingest.sentry.io/api/678/envelope/?sentry_key=4f0c2e`],
    [`STRIPE_WEBHOOK_SECRET`, `whsec_5f2d8c1a9b7e4f60`],
    [`GITLAB_LAN_TOKEN`, `${"glpat-"}xY7mQ2vR9kL4nT8wZ1aB`],
    [`VPN_PASSWORD`, `correct horse battery staple`],
    [`SESSION_SECRET`, `9c1f7e2a4b6d8e0f1a3c5e7b9d2f4a6c`],
    [`github`, `ghp_demo0000000000000000000000000000`],
    [`postgres`, `postgres://shop@db.internal/shop`],
    [`sentry`, `sntrys_demo`],
    [`discord`, `MTA5.demo.token`],
    [`stripe`, `sk_live_demo`],
]);

const gates: CredentialGate[] = [{ subject: `VPN_PASSWORD`, kind: `secret`, approvers: [`ada@acme.dev`, `jo@acme.dev`], scope: `use` }];

const hosts = new Map<string, SecretHostGuard>([
    [`STRIPE_WEBHOOK_SECRET`, { subject: `STRIPE_WEBHOOK_SECRET`, kind: `secret`, guard: true, hosts: [`api.stripe.com`], source: `owner` }],
    [`github`, { subject: `github`, kind: `capability`, guard: true, hosts: [`api.github.com`, `*.githubusercontent.com`], source: `connector` }],
]);

const programs = new Map<string, Omit<SecretProgramGuard, `subject`>>([
    [`VPN_PASSWORD`, { programs: [`FortiClient.exe`], packages: [`com.fortinet.forticlient`], anyField: false }],
]);

const CONNECTOR_RULES = {
    github: [
        { action: `deny`, methods: [`DELETE`], paths: [`/repos/*/*`], why: `Never delete a repository` },
        { action: `ask`, methods: [`PUT`, `PATCH`], paths: [`/repos/*/*/branches/*/protection`], why: `Branch protection is yours` },
    ],
    stripe: [{ action: `ask`, methods: [`POST`], paths: [`/v1/refunds`], why: `Refunds move money` }],
} satisfies Readonly<Record<string, BrokerRule[]>>;
const connectorRules = (subject: string): BrokerRule[] => (subject === `github` || subject === `stripe` ? CONNECTOR_RULES[subject] : []);
const policies = new Map<string, Omit<CredentialPolicy, `subject`>>([
    [`github`, { delivery: `gateway`, rules: CONNECTOR_RULES.github, rulesFrom: `connector` }],
    [`stripe`, { delivery: `gateway`, rules: CONNECTOR_RULES.stripe, rulesFrom: `connector` }],
    [`postgres`, { delivery: `direct`, rules: [], rulesFrom: `connector` }],
]);

const removed = new Set<string>();

const joined = (entry: SecretInventoryEntry): SecretInventoryEntry => {
    const row: SecretInventoryEntry = { ...entry };
    const gate = gates.find((held) => held.subject === entry.key);
    if (gate !== undefined) {
        row.gate = { approvers: gate.approvers, scope: gate.scope };
    }
    const host = hosts.get(entry.key);
    if (host !== undefined) {
        row.hosts = { guard: host.guard, list: host.hosts, source: host.source };
    }
    const program = programs.get(entry.key);
    if (program !== undefined && entry.kind !== `capability`) {
        row.programs = { ...program, source: `owner` };
    }
    const policy = policies.get(entry.key);
    if (policy !== undefined) {
        row.credential = policy;
    }
    return row;
};

// Where DevOps keeps the owner's values once it is active: a path, so the open row shows how one wraps.
const OWN_STORE = `desired-state/.env`;

const base = (now: number): SecretInventoryEntry[] => [
    ...[`github`, `postgres`, `sentry`, `discord`, `stripe`].map((key) => {
        const entry: SecretInventoryEntry = {
            key,
            kind: `capability`,
            status: `connected`,
            requiredBy: [],
            storedAt: `the capability vault`,
            revealable: true,
        };
        if (key === `github`) {
            entry.lastUse = { at: now - 2 * HOUR, lane: `gateway`, detail: `api.github.com` };
        }
        return entry;
    }),
    {
        key: `DATABASE_URL`,
        kind: `env`,
        status: `set`,
        requiredBy: [],
        storedAt: OWN_STORE,
        revealable: true,
        lastUse: { at: now - 20 * 60_000, lane: `code`, detail: `node scripts/migrate.mjs` },
    },
    { key: `SENTRY_DSN`, kind: `env`, status: `set`, requiredBy: [], storedAt: OWN_STORE, revealable: true },
    { key: `STRIPE_WEBHOOK_SECRET`, kind: `env`, status: `set`, requiredBy: [], storedAt: OWN_STORE, revealable: true },
    {
        key: `GITLAB_LAN_TOKEN`,
        kind: `env`,
        status: `set`,
        requiredBy: [],
        storedAt: OWN_STORE,
        revealable: true,
        lastUse: {
            at: now - 7 * HOUR,
            lane: `shell`,
            detail: `cd /tmp && H=$(mktemp -d) && printf 'https://oauth2:%s@192.168.0.168\\n' '{{secret:GITLAB_LAN_TOKEN}}' > "$H/creds"`,
        },
    },
    {
        key: `VPN_PASSWORD`,
        kind: `env`,
        status: `set`,
        requiredBy: [],
        storedAt: OWN_STORE,
        revealable: true,
        lastUse: { at: now - 26 * HOUR, lane: `device`, detail: `rog · FortiClient.exe`, approvedBy: `ada@acme.dev` },
    },
    { key: `SESSION_SECRET`, kind: `generated`, status: `set`, requiredBy: [], storedAt: `generated by the sandbox`, revealable: true },
    {
        key: `BANK_PIN`,
        label: `Bank PIN`,
        kind: `device`,
        status: `set`,
        requiredBy: [],
        storedAt: `the keyring on rog`,
        revealable: false,
        programs: { programs: [`chrome.exe`], packages: [], anyField: false, source: `keyring` },
        device: { machine: `rog`, mode: `each-use`, online: true, locked: false, source: `keyring` },
    },
];

/** The secrets inventory: the connections' own credentials, the values the owner keeps, one the sandbox made and one kept
 *  in a computer's keyring, each with its rules joined on, so the Secrets page and the person dialog's reach both read as
 *  a working sandbox's. */
const demoSecretInventory = (now: number = Date.now()): SecretInventoryEntry[] =>
    base(now)
        .filter((entry) => !removed.has(entry.key))
        .map((entry) => (values.has(entry.key) || entry.kind === `device` ? joined(entry) : { ...joined(entry), status: `missing` as const }));

const policyOf = (subject: string): CredentialPolicy => {
    const policy = policies.get(subject);
    if (policy === undefined) {
        throw new Error(`No credential policy for ${subject}`);
    }
    return { subject, ...policy };
};

// The daemon's `/secrets` routes over the stores above, spread into the fixture router (daemon/procedures.ts).
export const secretDoors = {
    inventory: () => ({ entries: demoSecretInventory() }),
    reveal: ({ key }: { readonly key: string }) => {
        const value = values.get(key);
        if (value === undefined) {
            throw new Error(`${key} has no value`);
        }
        return { value };
    },
    set: ({ key, value }: { readonly key: string; readonly value: string }) => {
        values.set(key, value);
        removed.delete(key);
        return { ok: true as const };
    },
    remove: ({ key }: { readonly key: string }) => {
        values.delete(key);
        removed.add(key);
        return { ok: true as const };
    },
    gates: () => ({ gates }),
    setGate: (gate: CredentialGate) => {
        const at = gates.findIndex((held) => held.subject === gate.subject);
        if (at === -1) {
            gates.push(gate);
        } else {
            gates[at] = gate;
        }
        return { ok: true as const };
    },
    removeGate: ({ subject }: { readonly subject: string }) => {
        const at = gates.findIndex((held) => held.subject === subject);
        if (at !== -1) {
            gates.splice(at, 1);
        }
        return { ok: true as const };
    },
    hosts: () => ({ guards: [...hosts.values()] }),
    setHosts: ({ subject, kind, guard, hosts: list }: { subject: string; kind?: CredentialGateKind | undefined; guard: boolean; hosts: string[] }) => {
        const before = hosts.get(subject);
        hosts.set(subject, { subject, kind: kind ?? before?.kind ?? `secret`, guard, hosts: list, source: `owner` });
        return { guard, hosts: list };
    },
    programs: () => ({ guards: [...programs.entries()].map(([subject, guard]) => ({ subject, ...guard })) }),
    setPrograms: ({ subject, programs: list, packages, anyField }: SecretProgramGuard) => {
        programs.set(subject, { programs: list, packages, anyField });
        return { programs: list, packages, anyField };
    },
    // The owner's workstation, with its keyring unlocked, so Type into… has somewhere to type.
    keyrings: () => ({ keyrings: [{ machine: `rog`, online: true, locked: false, setUp: true, shared: 1 }] }),
    // Waits out the countdown the way the computer does, then answers where it went.
    typeInto: async ({ key, countdownSeconds }: { key: string; countdownSeconds: number }) => {
        await new Promise((resolve) => setTimeout(resolve, countdownSeconds * 1000));
        const listed = programs.get(key)?.programs[0];
        return { program: listed ?? `notepad.exe`, field: listed === undefined ? (`text` as const) : (`password` as const), asked: listed === undefined };
    },
    policy: ({ subject }: { readonly subject: string }) => policyOf(subject),
    setPolicy: ({ subject, delivery, rules }: CredentialPolicySet) => {
        const before = policyOf(subject);
        const next = {
            delivery: delivery ?? before.delivery,
            rules: rules === undefined ? before.rules : rules === null ? connectorRules(subject) : rules,
            rulesFrom: rules === undefined ? before.rulesFrom : rules === null ? (`connector` as const) : (`owner` as const),
        };
        policies.set(subject, next);
        return { subject, ...next };
    },
};
