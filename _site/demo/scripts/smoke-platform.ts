// Routes one request per procedure the demo's platform serves through its fetch handler (src/platform.ts), encoded the
// way the editor's OpenAPILink encodes it, and parses every answer with the api contract's own output schema. The run
// is a visitor's afternoon in order, since the platform is live state: on a sandbox's first day (`fresh`, the account
// with no plan yet) it checks out, buys a slot, puts the sandbox on a machine of ours, moves it, rebuilds its
// environment and rolls it back, and a few reads after a write check that the write stuck. The demo's modules are
// Vite-shaped, so Vite bundles them for Node first, as smoke-daemon.ts does. Run: `pnpm -C _site/demo smoke:platform`.

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

type Platform = typeof import("../src/platform.ts");
type Api = typeof import("@intentic/api-contract")["apiContract"];
type Answers = Platform["PLATFORM_ANSWERS"];
type Handler<C> = import("../src/platform/serve.ts").PlatformHandler<C>;

// What a procedure is handed and answers, as its handler is typed.
type Procedure<G, P> = G extends keyof Api ? (P extends keyof Api[G] ? Api[G][P] : never) : never;
type Input<G, P> = Parameters<Handler<Procedure<G, P>>>[0];
type Output<G, P> = Awaited<ReturnType<Handler<Procedure<G, P>>>>;

// Every answer so far, by group and procedure, so a later step can send what an earlier one was given (a hand-off's id).
type Seen = { -readonly [G in keyof Answers]?: { -readonly [P in keyof Answers[G]]?: Output<G, P> } };

type Step = {
    readonly [G in keyof Answers]: {
        readonly [P in keyof Answers[G]]: {
            readonly group: G;
            readonly name: P;
            readonly input: (seen: Seen) => Input<G, P>;
            // What the answer must say for the write before it to have stuck; undefined when it does.
            readonly check?: (answer: NonNullable<Output<G, P>>) => string | undefined;
            // How long the step waits first, for something paced (a build) to get where it needs to be.
            readonly after?: number;
        };
    }[keyof Answers[G]];
}[keyof Answers];

// What a response body is: JSON.
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

// A schema as oRPC reads one: Standard Schema, whichever library wrote it.
interface Schema {
    readonly "~standard": {
        readonly validate: (value: Json) => { readonly issues?: readonly { readonly message: string }[] } | Promise<{ readonly issues?: readonly { readonly message: string }[] }>;
    };
}
interface ContractProcedure {
    readonly "~orpc": { readonly route: { readonly method?: string; readonly path?: string }; readonly outputSchema?: Schema };
}

const DEMO_ROOT = fileURLToPath(new URL(`..`, import.meta.url));
// The handler reads a request's path, query and body; the origin is the demo's own platform's.
const ORIGIN = `https://api.demo.invalid`;
const SANDBOX = `demo`;
// The PKCE pair the desktop app would hold: the challenge rides the browser's hand-off, the verifier the app's redeem.
const VERIFIER = `smoke-verifier-${`v`.repeat(40)}`;
const CHALLENGE = createHash(`sha256`).update(VERIFIER).digest(`base64url`);
const OVERLAY = `FROM ghcr.io/intentic/sandbox:stable\nRUN apt-get install -y ripgrep\n`;
const OVERLAY_HASH = createHash(`sha256`).update(OVERLAY).digest(`hex`);
// Long enough for the build to finish and the machine to restart onto it (world/builds.ts), past the move before it.
const BUILD_MS = 12_000;

const store = (): Storage => {
    const held = new Map<string, string>();
    return {
        getItem: (key) => held.get(key) ?? null,
        setItem: (key, value) => void held.set(key, value),
        removeItem: (key) => void held.delete(key),
        clear: () => held.clear(),
        key: () => null,
        get length() {
            return held.size;
        },
    };
};

const ignore = (): void => {};
const element = () => ({
    dataset: {},
    style: { setProperty: ignore, removeProperty: ignore, getPropertyValue: () => `` },
    classList: { add: ignore, remove: ignore, toggle: ignore, contains: () => false },
    setAttribute: ignore,
    getAttribute: () => null,
    removeAttribute: ignore,
    appendChild: ignore,
    addEventListener: ignore,
    removeEventListener: ignore,
});

// What the demo's modules read from the browser as they load: a sandbox's first day, the account with no plan yet.
const stubBrowser = (): void => {
    const sessionStorage = store();
    sessionStorage.setItem(`intentic.demo.mode`, `fresh`);
    Object.assign(globalThis, {
        window: globalThis,
        location: new URL(`https://demo.smoke.invalid/demo/settings/billing`),
        history: { state: null, replaceState: ignore, pushState: ignore },
        sessionStorage,
        localStorage: store(),
        addEventListener: ignore,
        removeEventListener: ignore,
        dispatchEvent: () => true,
        matchMedia: (media: string) => ({ matches: false, media, addEventListener: ignore, removeEventListener: ignore, addListener: ignore, removeListener: ignore }),
        document: {
            documentElement: element(),
            head: element(),
            body: element(),
            createElement: element,
            addEventListener: ignore,
            removeEventListener: ignore,
            querySelector: () => null,
            querySelectorAll: () => [],
            visibilityState: `visible`,
        },
    });
};

const ENTRIES = { platform: `src/platform.ts`, contract: `@intentic/api-contract` } as const;

const bundle = async (out: string): Promise<void> => {
    await build({
        root: DEMO_ROOT,
        configFile: join(DEMO_ROOT, `vite.config.ts`),
        logLevel: `error`,
        publicDir: false,
        ssr: { noExternal: true, target: `node` },
        build: {
            ssr: true,
            outDir: out,
            emptyOutDir: true,
            minify: false,
            rolldownOptions: {
                // The platform is what this run checks; an import broken elsewhere in the demo (a daemon module mid-edit)
                // is the typecheck's to name, and should not stop the platform from being asked.
                shimMissingExports: true,
                input: Object.fromEntries(Object.entries(ENTRIES).map(([name, entry]) => [name, entry.startsWith(`src/`) ? join(DEMO_ROOT, entry) : entry])),
            },
        },
    });
};

// SAFETY: typed as the module it was bundled from; the bundle is that module, compiled.
const loaded = async <T>(out: string, entry: keyof typeof ENTRIES): Promise<T> => (await import(pathToFileURL(join(out, `${entry}.js`)).href)) as T;

// The check's verdict: nothing when the answer says what it should, else what it should have said.
const said = (holds: boolean, what: string): string | undefined => (holds ? undefined : what);
const createdId = (seen: Seen): string => seen.sandbox?.create?.id ?? ``;

// The afternoon, in order. Each write that a later read should reflect is followed by that read and its check.
const STEPS: readonly Step[] = [
    { group: `me`, name: `get`, input: () => undefined },
    { group: `me`, name: `signInOptions`, input: () => undefined },
    { group: `hostedPlan`, name: `state`, input: () => undefined, check: (plan) => said(!plan.onPlan, `a first-day account is not on the plan`) },
    { group: `hostedPlan`, name: `checkout`, input: () => ({ tier: `standard` }), check: (door) => said(door.url.includes(`/settings/billing?plan=welcome`), `checkout returns to Billing`) },
    { group: `hostedPlan`, name: `state`, input: () => undefined, check: (plan) => said(plan.onPlan, `the checkout put the account on the plan`) },
    { group: `hostedPlan`, name: `setSlots`, input: () => ({ tier: `max`, quantity: 1 }), check: (plan) => said(plan.hosted?.slotsByTier[`max`] === 1, `a Max slot was bought`) },
    { group: `hostedPlan`, name: `portal`, input: () => undefined },
    { group: `sandbox`, name: `list`, input: () => undefined },
    { group: `sandbox`, name: `hostedOffer`, input: () => ({}) },
    { group: `sandbox`, name: `addressOffer`, input: () => undefined },
    { group: `sandbox`, name: `hostedProvision`, input: () => ({ sandboxId: SANDBOX, token: `smoke`, tier: `standard` }) },
    { group: `sandbox`, name: `hostedStatus`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `hostedRebuild`, input: () => ({ sandboxId: SANDBOX, hash: OVERLAY_HASH, content: OVERLAY }) },
    { group: `sandbox`, name: `hostedBuildStatus`, input: () => ({ sandboxId: SANDBOX }), check: (status) => said(status.build?.state === `building`, `the build is under way`) },
    {
        group: `hostedPlan`,
        name: `changeTier`,
        input: () => ({ sandboxId: SANDBOX, tier: `max` }),
        check: (move) => said(move.state === `done` && move.toTier === `max`, `the move finished on Max`),
    },
    {
        group: `sandbox`,
        name: `hostedBuildStatus`,
        input: () => ({ sandboxId: SANDBOX }),
        check: (status) => said(status.applied === OVERLAY_HASH, `the build finished and was applied`),
        after: BUILD_MS,
    },
    { group: `sandbox`, name: `hostedRollback`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `hostedRestart`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `wake`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `ownerTicket`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `identityAssertion`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `zones`, input: () => ({ token: `cf_smoke_token_0123456789abcdefghijklmnop` }), check: (found) => said(found.zones.length > 0, `the token sees zones`) },
    { group: `sandbox`, name: `adoptionTicket`, input: () => ({ sandboxId: `0123456789ab` }) },
    { group: `sandbox`, name: `emailSetupLink`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `fixCode`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `sandbox`, name: `lookup`, input: () => ({ sandboxIds: [`fedcba987654`] }) },
    { group: `sandbox`, name: `create`, input: () => ({ name: `smoke-scratch` }) },
    { group: `sandbox`, name: `setupCode`, input: (seen) => ({ sandboxId: createdId(seen) }) },
    { group: `sandbox`, name: `update`, input: (seen) => ({ sandboxId: createdId(seen), name: `smoke-renamed` }) },
    { group: `sandbox`, name: `attach`, input: (seen) => ({ sandboxId: createdId(seen), daemonUrl: `https://smoke.demo.invalid` }) },
    { group: `sandbox`, name: `delete`, input: (seen) => ({ sandboxId: createdId(seen) }) },
    { group: `sandbox`, name: `trash`, input: () => undefined },
    { group: `sandbox`, name: `restore`, input: (seen) => ({ trashId: seen.sandbox?.trash?.sandboxes[0]?.id ?? `` }) },
    { group: `sandbox`, name: `hostedRelease`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `token`, name: `create`, input: () => ({ label: `smoke`, scope: `provision` }), check: (minted) => said(minted.token.startsWith(`itk_`), `the value is shown once`) },
    { group: `token`, name: `list`, input: () => undefined, check: (list) => said(list.tokens.some((token) => token.label === `smoke`), `the new token is listed`) },
    {
        group: `token`,
        name: `revoke`,
        input: (seen) => ({ tokenId: seen.token?.create?.id ?? `` }),
        check: (list) => said(!list.tokens.some((token) => token.label === `smoke`), `the revoked token is gone`),
    },
    { group: `wallet`, name: `setPolicy`, input: () => ({ network: `eip155:8453`, perPaymentMaxUsd: `0.50`, dailyCapUsd: `5` }) },
    { group: `push`, name: `register`, input: () => ({ platform: `android`, token: `smoke-fcm-token` }) },
    { group: `invite`, name: `list`, input: () => ({ sandboxId: SANDBOX }) },
    { group: `invite`, name: `create`, input: () => ({ sandboxId: SANDBOX, email: `lee@acme.dev`, role: `viewer` }) },
    { group: `invite`, name: `resend`, input: () => ({ sandboxId: SANDBOX, email: `rin@acme.dev` }) },
    { group: `invite`, name: `setRole`, input: () => ({ sandboxId: SANDBOX, email: `rin@acme.dev`, role: `collaborator` }) },
    { group: `invite`, name: `revoke`, input: () => ({ sandboxId: SANDBOX, email: `rin@acme.dev` }) },
    { group: `invite`, name: `preview`, input: () => ({ token: `smoke-invite` }), check: (preview) => said(preview.status === `pending`, `the link is pending`) },
    { group: `invite`, name: `accept`, input: () => ({ token: `smoke-invite` }) },
    { group: `sandbox`, name: `list`, input: () => undefined, check: (list) => said(list.sandboxes.some((row) => row.name === `acme-design` && row.role === `collaborator`), `the accepted sandbox is listed`) },
    { group: `sandbox`, name: `leave`, input: (seen) => ({ sandboxId: seen.invite?.accept?.sandboxId ?? `` }) },
    { group: `org`, name: `list`, input: () => undefined },
    { group: `org`, name: `create`, input: () => ({ name: `Acme` }), check: (org) => said(org.role === `admin`, `the creator is its admin`) },
    { group: `org`, name: `get`, input: () => ({ orgId: `transport-office` }) },
    {
        group: `org`,
        name: `setPolicy`,
        input: () => ({ orgId: `transport-office`, rules: { sections: { secrets: `hidden` } }, expectedVersion: 2 }),
        check: (org) => said(org.policyVersion === 3, `a new edition`),
    },
    { group: `org`, name: `addMember`, input: () => ({ orgId: `transport-office`, email: `clerk@example.test`, role: `member` }) },
    { group: `org`, name: `removeMember`, input: () => ({ orgId: `transport-office`, email: `clerk@example.test` }) },
    {
        group: `org`,
        name: `bindSandbox`,
        input: () => ({ orgId: `transport-office`, sandboxId: SANDBOX }),
        check: (org) => said(org.sandboxes?.some((row) => row.id === SANDBOX) === true, `the sandbox is bound`),
    },
    { group: `org`, name: `unbindSandbox`, input: () => ({ orgId: `transport-office`, sandboxId: SANDBOX }) },
    { group: `desktop`, name: `googleIdToken`, input: () => undefined },
    { group: `desktop`, name: `handoff`, input: (seen) => ({ idToken: seen.desktop?.googleIdToken?.idToken ?? `none`, challenge: CHALLENGE }) },
    { group: `desktop`, name: `redeem`, input: (seen) => ({ handoff: seen.desktop?.handoff?.handoff ?? ``, verifier: VERIFIER }) },
    { group: `me`, name: `export`, input: () => undefined },
];

// A request as the editor's OpenAPILink sends it: a GET's input as its query, any other method's as a JSON body.
const requestFor = (procedure: ContractProcedure, input: Json | undefined): Request => {
    const { method = `POST`, path = `` } = procedure[`~orpc`].route;
    const url = new URL(`/rpc${path}`, ORIGIN);
    if (method === `GET`) {
        for (const [key, value] of Object.entries(input ?? {})) {
            url.searchParams.append(key, String(value));
        }
        return new Request(url);
    }
    return input === undefined ? new Request(url, { method }) : new Request(url, { method, headers: { "content-type": `application/json` }, body: JSON.stringify(input) });
};

const problemsOf = async (schema: Schema, value: Json): Promise<string | undefined> => {
    const { issues } = await schema[`~standard`].validate(value);
    return issues === undefined ? undefined : issues.map((issue) => issue.message).join(`; `);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One step's request and its verdict: nothing when the answer parsed and said what it should; why not otherwise.
const run = async (platform: Platform[`platform`], procedure: ContractProcedure, output: Schema, step: Step, seen: Seen): Promise<string | undefined> => {
    await wait(step.after ?? 0);
    // SAFETY: each step's input is typed by its own procedure (`Step`); the union over all of them is what reaches here.
    const request = requestFor(procedure, (step.input as (seen: Seen) => Json | undefined)(seen));
    const response = await platform(request, new URL(request.url));
    // SAFETY: a response body is what JSON.parse made of it.
    const body = (await response.json()) as Json;
    if (response.status !== 200) {
        return `${response.status} ${JSON.stringify(body)}`;
    }
    const problem = await problemsOf(output, body);
    if (problem !== undefined) {
        return problem;
    }
    // SAFETY: the body parsed by this procedure's own output schema, which is the type its step and `Seen` read.
    const group = ((seen as Record<string, Record<string, Json>>)[step.group] ??= {});
    group[String(step.name)] = body;
    // SAFETY: as above; the check is typed by the same procedure's output.
    return body === null ? undefined : (step.check as ((answer: Json) => string | undefined) | undefined)?.(body);
};

const main = async (): Promise<number> => {
    stubBrowser();
    const out = await mkdtemp(join(tmpdir(), `demo-smoke-platform-`));
    await bundle(out);
    const { platform, PLATFORM_ANSWERS } = await loaded<Platform>(out, `platform`);
    const { apiContract } = await loaded<typeof import("@intentic/api-contract")>(out, `contract`);
    const procedures = new Map<string, ContractProcedure>(
        Object.entries(apiContract).flatMap(([group, members]) => Object.entries(members).map(([name, procedure]): [string, ContractProcedure] => [`${group}.${name}`, procedure])),
    );
    const served = Object.entries(PLATFORM_ANSWERS).flatMap(([group, answers]) => Object.keys(answers).map((name) => `${group}.${name}`));
    const failures = served.filter((name) => !STEPS.some((step) => `${step.group}.${String(step.name)}` === name)).map((name) => `${name}: served, but this run sends it nothing`);
    const seen: Seen = {};
    let parsed = 0;
    for (const step of STEPS) {
        // one at a time, in order: each step reads what the ones before it wrote
        const name = `${step.group}.${String(step.name)}`;
        const procedure = procedures.get(name);
        const output = procedure?.[`~orpc`].outputSchema;
        const problem = procedure === undefined || output === undefined ? `not a procedure the contract declares` : await run(platform, procedure, output, step, seen);
        if (problem === undefined) {
            parsed += 1;
        } else {
            failures.push(`${name}: ${problem}`);
        }
    }
    await rm(out, { recursive: true, force: true });
    for (const failure of failures) {
        console.error(`  ${failure}`);
    }
    console.log(`demo platform smoke: ${served.length} procedures served, ${STEPS.length} requests sent, ${parsed} answers parsed by their contract schema, ${failures.length} failures`);
    return failures.length === 0 ? 0 : 1;
};

// Exits by hand: the world's paced timers (a machine's boot, a policy applied) would otherwise hold the process open.
process.exit(await main());
