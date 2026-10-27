// Routes one request per procedure the fixture daemon serves through its dispatcher (src/router.ts), encoded the way the
// editor's typed client encodes it, and parses every answer with the contract's own output schema. The demo's modules
// are Vite-shaped (import.meta.glob, .vue), so Vite bundles them for Node first. Run: `pnpm -C _site/demo smoke`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContractRoute } from "@intentic/sandbox-contract/protocol/routes";
import type { SandboxCallInput, SandboxProcedure } from "@intentic/sandbox-contract/protocol/procedure-types";
import { build } from "vite";
import { samplesOf } from "./samples/index.ts";

type Contract = typeof import("@intentic/sandbox-contract") & Pick<typeof import("@intentic/sandbox-contract/protocol/routes"), "requestPathFor">;
type Daemon = typeof import("../src/daemon.ts");
type Router = typeof import("../src/daemon/procedures.ts")["procedures"];

// One input per served procedure, as the editor hands it to its client; a handler added without one fails to compile.
export type Samples = { readonly [G in keyof Router]: { readonly [P in keyof Router[G]]: SandboxCallInput<G, P & SandboxProcedure<G>> } };

// What an answer was: parsed by its schema, the fixture's deliberate `{ error }` refusal, or a failure to report.
type Verdict = { readonly kind: `answered` | `refused` } | { readonly kind: `failed`; readonly why: string };

// A schema as oRPC reads one: Standard Schema, whichever library wrote it.
interface Schema {
    readonly "~standard": {
        readonly validate: (
            value: unknown,
        ) => { readonly issues?: readonly { readonly message: string }[] } | Promise<{ readonly issues?: readonly { readonly message: string }[] }>;
    };
}

const DEMO_ROOT = fileURLToPath(new URL(`..`, import.meta.url));
// The dispatcher reads only a request's path, query and body; the origin is never consulted.
const ORIGIN = `https://daemon.smoke.invalid`;
// Frames read off a stream before it is let go, and how long to wait for them.
const FRAMES = 4;
const STREAM_MS = 5_000;

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

// What the demo's modules read from the browser as they load; the full recording, so every agent and extension is on.
const stubBrowser = (): void => {
    const sessionStorage = store();
    sessionStorage.setItem(`intentic.demo.mode`, `full`);
    Object.assign(globalThis, {
        window: globalThis,
        location: new URL(`https://demo.smoke.invalid/demo/agents`),
        history: { state: null, replaceState: ignore, pushState: ignore },
        sessionStorage,
        localStorage: store(),
        addEventListener: ignore,
        removeEventListener: ignore,
        dispatchEvent: () => true,
        matchMedia: (media: string) => ({
            matches: false,
            media,
            addEventListener: ignore,
            removeEventListener: ignore,
            addListener: ignore,
            removeListener: ignore,
        }),
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

// Every module the run reads, bundled once so the daemon and the fixtures below share one instance of each.
const ENTRIES = {
    daemon: `src/daemon.ts`,
    procedures: `src/daemon/procedures.ts`,
    router: `@intentic/contract-serve`,
    fleet: `src/fixture/fleet.ts`,
    automations: `src/fixture/automations.ts`,
    ci: `src/fixture/ci.ts`,
    workflows: `src/fixture/workflows.ts`,
    loops: `src/fixture/loops.ts`,
    devices: `src/fixture/devices.ts`,
    approvals: `src/fixture/approvals.ts`,
    contract: `@intentic/sandbox-contract`,
    routes: `@intentic/sandbox-contract/protocol/routes`,
} as const;

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
                input: Object.fromEntries(
                    Object.entries(ENTRIES).map(([name, entry]) => [name, entry.startsWith(`src/`) ? join(DEMO_ROOT, entry) : entry]),
                ),
            },
        },
    });
};

// Typed as the module it was bundled from; the bundle is that module, compiled.
const loaded = async <T>(out: string, entry: keyof typeof ENTRIES): Promise<T> => (await import(pathToFileURL(join(out, `${entry}.js`)).href)) as T;

const fixturesOf = async (out: string) => ({
    fleet: await loaded<typeof import("../src/fixture/fleet.ts")>(out, `fleet`),
    automations: await loaded<typeof import("../src/fixture/automations.ts")>(out, `automations`),
    ci: await loaded<typeof import("../src/fixture/ci.ts")>(out, `ci`),
    workflows: await loaded<typeof import("../src/fixture/workflows.ts")>(out, `workflows`),
    loops: await loaded<typeof import("../src/fixture/loops.ts")>(out, `loops`),
    devices: await loaded<typeof import("../src/fixture/devices.ts")>(out, `devices`),
    approvals: await loaded<typeof import("../src/fixture/approvals.ts")>(out, `approvals`),
});

// A request as the editor's OpenAPILink sends it (oRPC's compact structure): each `{param}` filled into the path, the
// remaining fields as a GET's query or as any other method's JSON body, and nothing at all when none remain.
const requestFor = (contract: Contract, route: ContractRoute, input: unknown): Request => {
    const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? ``);
    const fields = typeof input === `object` && input !== null ? Object.entries(input).filter(([key]) => !params.includes(key)) : [];
    const rest = params.length === 0 ? input : fields.length > 0 ? Object.fromEntries(fields) : undefined;
    const url = new URL(contract.requestPathFor(route, input), ORIGIN);
    if (route.method === `GET`) {
        for (const [key, value] of Object.entries(rest ?? {})) {
            url.searchParams.append(key, String(value));
        }
        return new Request(url);
    }
    return rest === undefined
        ? new Request(url, { method: route.method })
        : new Request(url, { method: route.method, headers: { "content-type": `application/json` }, body: JSON.stringify(rest) });
};

// Nothing when the value parses; the schema's own words when it does not.
const problemsOf = async (schema: Schema, value: unknown): Promise<string | undefined> => {
    const { issues } = await schema[`~standard`].validate(value);
    return issues === undefined ? undefined : issues.map((issue) => issue.message).join(`; `);
};

// The complete events in a buffer of an oRPC event stream, and the partial one it ends on.
const eventsIn = (buffer: string): { readonly frames: unknown[]; readonly done: boolean; readonly rest: string } => {
    const events = buffer.split(`\n\n`);
    const rest = events.pop() ?? ``;
    const kinds = events.map((event) => ({ kind: /^event: (.*)$/m.exec(event)?.[1], data: /^data: (.*)$/m.exec(event)?.[1] }));
    return {
        frames: kinds.flatMap(({ kind, data }) => (kind === `message` && data !== undefined ? [JSON.parse(data)] : [])),
        done: kinds.some(({ kind }) => kind === `done`),
        rest,
    };
};

// The first frames of an event stream, then let go of it, which is the consumer hanging up and runs the teardown.
const framesOf = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown[]> => {
    const decoder = new TextDecoder();
    const deadline = Date.now() + STREAM_MS;
    const frames: unknown[] = [];
    let buffer = ``;
    let done = false;
    while (!done && frames.length < FRAMES && Date.now() < deadline) {
        // a stream is read in order, one chunk after another
        const chunk = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, deadline - Date.now()))]);
        if (chunk?.value === undefined) {
            break;
        }
        const read = eventsIn(buffer + decoder.decode(chunk.value, { stream: true }));
        frames.push(...read.frames);
        ({ done, rest: buffer } = read);
    }
    await reader.cancel();
    return frames;
};

const answered = async (schema: Schema, values: readonly unknown[]): Promise<Verdict> => {
    const problems = (await Promise.all(values.map((value) => problemsOf(schema, value)))).filter((problem) => problem !== undefined);
    return problems.length === 0 ? { kind: `answered` } : { kind: `failed`, why: problems.join(` | `) };
};

// A stream's frames, each parsed by the frame schema its procedure declares beside the output (streamOf in the contract).
const streamVerdict = async (response: Response, output: Schema): Promise<Verdict> => {
    const frame = (output as Schema & Partial<Record<symbol, Schema>>)[Symbol.for(`intentic.contract.frame`)];
    const reader = response.body?.getReader();
    const frames = reader === undefined ? [] : await framesOf(reader);
    if (frame === undefined || frames.length === 0) {
        return { kind: `failed`, why: frame === undefined ? `a stream from a procedure that answers once` : `a stream that sent no frame` };
    }
    return answered(frame, frames);
};

const refusalVerdict = (body: unknown): Verdict =>
    typeof body === `object` && body !== null && `error` in body && typeof body.error === `string`
        ? { kind: `refused` }
        : { kind: `failed`, why: `a 403 without the daemon's { error } body: ${JSON.stringify(body)}` };

const verdictOf = async (response: Response, output: Schema): Promise<Verdict> => {
    if (response.status === 403) {
        return refusalVerdict(await response.json());
    }
    if (response.status !== 200) {
        return { kind: `failed`, why: `${response.status} ${await response.text()}` };
    }
    return response.headers.get(`content-type`) === `text/event-stream` ? streamVerdict(response, output) : answered(output, [await response.json()]);
};

const outputSchemaOf = (contract: Contract, name: string): Schema | undefined => {
    const [group = ``, procedure = ``] = name.split(`.`);
    const procedures = contract.sandboxContract as unknown as Readonly<
        Record<string, Readonly<Record<string, { readonly "~orpc": { readonly outputSchema?: Schema } }>>>
    >;
    return procedures[group]?.[procedure]?.[`~orpc`].outputSchema;
};

const verdictFor = async (contract: Contract, daemon: Daemon["daemon"], name: string, input: unknown): Promise<Verdict> => {
    const route = contract.SANDBOX_ROUTES.find((candidate) => candidate.name === name);
    const output = outputSchemaOf(contract, name);
    if (route === undefined || output === undefined) {
        return { kind: `failed`, why: `not a procedure the contract declares` };
    }
    const request = requestFor(contract, route, input);
    return verdictOf(await daemon(request, new URL(request.url)), output);
};

const main = async (): Promise<number> => {
    stubBrowser();
    const out = await mkdtemp(join(tmpdir(), `demo-smoke-`));
    await bundle(out);
    const { daemon } = await loaded<Daemon>(out, `daemon`);
    const { procedures } = await loaded<typeof import("../src/daemon/procedures.ts")>(out, `procedures`);
    const { servedProcedures } = await loaded<typeof import("@intentic/contract-serve")>(out, `router`);
    const contract: Contract = {
        ...(await loaded<Contract>(out, `contract`)),
        requestPathFor: (await loaded<Contract>(out, `routes`)).requestPathFor,
    };
    const samples = samplesOf(await fixturesOf(out), Date.now());
    const sent = Object.entries(samples).flatMap(([group, inputs]) =>
        Object.entries(inputs).map(([name, input]) => ({ name: `${group}.${name}`, input })),
    );
    const failures = servedProcedures(procedures)
        .filter((name) => !sent.some((sample) => sample.name === name))
        .map((name) => `${name}: served, but this run sends it nothing`);
    const tally = { answered: 0, refused: 0 };
    for (const { name, input } of sent) {
        // one at a time, since the handlers share the fixture's live state
        const verdict = await verdictFor(contract, daemon, name, input);
        if (verdict.kind === `failed`) {
            failures.push(`${name}: ${verdict.why}`);
        } else {
            tally[verdict.kind] += 1;
        }
    }
    await rm(out, { recursive: true, force: true });
    for (const failure of failures) {
        console.error(`  ${failure}`);
    }
    console.log(
        `demo smoke: ${sent.length} procedures sent, ${tally.answered} answers parsed by their contract schema, ${tally.refused} refused as the fixture means to, ${failures.length} failures`,
    );
    return failures.length === 0 ? 0 : 1;
};

// Exits by hand: the recording's timers (heartbeats, a scripted turn) would otherwise hold the process open.
process.exit(await main());
