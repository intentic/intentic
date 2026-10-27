import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import { type AddInventoryInput, INVENTORY_PATH, type InventoryEntry } from "@intentic/sandbox-contract/schemas/inventory";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { Frames, refuse, type StreamSink } from "@intentic/contract-serve";
import { deskEdition, freshEdition } from "../../mode";
import { listeners } from "../board/roster";
import { registerTerminalSource } from "./terminals";

// The deployment side of acme-shop: what deploy.config.ts declares (the inventory), and the in-sandbox `intentic` CLI's
// streamed runs over it, resolve, plan and the minutes-long apply → adopt the daemon runs in a terminal and logs to a
// durable file. Paced like the real CLI, so a press is watched rather than over before anything draws.

const STEP_MS = 650;

type InventoryList = SandboxHandlerOutput<`inventory`, `list`>;

// One Hetzner machine behind Cloudflare, the GitHub org, the shop's two apps and the tracing it ships to.
let entries: InventoryEntry[] =
    deskEdition || freshEdition
        ? []
        : [
              { kind: `backend`, provider: `host`, name: `fsn1`, values: { address: `fsn1.acme.dev`, user: `deploy`, port: 22, via: `cloudflared` } },
              { kind: `backend`, provider: `cloudflare`, name: `acme_dev`, values: { zone: `acme.dev` } },
              { kind: `backend`, provider: `github`, name: `acme`, values: { org: `acme` } },
              { kind: `app`, name: `web`, values: { domain: `shop.acme.dev`, repo: `web` }, on: `fsn1`, expose: `acme_dev` },
              { kind: `app`, name: `api`, values: { domain: `api.acme.dev`, repo: `api` }, on: `fsn1`, expose: `acme_dev` },
              { kind: `service`, service: `signoz`, name: `tracing`, values: { domain: `traces.acme.dev` }, on: `fsn1`, expose: `acme_dev` },
          ];

// The daemon rewrites the managed region and commits it; the tree hears the file change.
const rewrote = (): InventoryList => {
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths: [INVENTORY_PATH] });
    }
    return { entries: [...entries] };
};

export const inventoryList = (): InventoryList => ({ entries: [...entries] });

export const addInventory = (input: AddInventoryInput): InventoryList => {
    if (entries.some((entry) => entry.name === input.name)) {
        return refuse(`Something is already declared as ${input.name}; pick another name.`, 409);
    }
    entries = [...entries, input];
    return rewrote();
};

export const removeInventory = (name: string): InventoryList => {
    if (!entries.some((entry) => entry.name === name)) {
        return refuse(`Nothing is declared as ${name}.`, 404);
    }
    entries = entries.filter((entry) => entry.name !== name);
    return rewrote();
};

// The resource each declared entry becomes, as the CLI's graph names it.
const nodeOf = (entry: InventoryEntry): { id: string; type: string } =>
    entry.kind === `backend`
        ? { id: `${entry.provider}.${entry.name}`, type: entry.provider }
        : entry.kind === `app`
          ? { id: `app.${entry.name}`, type: `app` }
          : { id: `service.${entry.name}`, type: entry.service };

// Lines a few hundred milliseconds apart, then the stream closes, as the CLI's output arrives through the daemon.
const paced = (lines: readonly IntenticLine[], sink: StreamSink<IntenticLine>, done?: () => void): (() => void) => {
    let step = 0;
    const timer = setInterval(() => {
        const line = lines[step];
        if (line === undefined) {
            clearInterval(timer);
            done?.();
            sink.close();
            return;
        }
        sink.emit(line);
        step += 1;
    }, STEP_MS);
    return () => clearInterval(timer);
};

// Up to date except the tracing service, which was declared after the last apply, and the api, whose domain moved.
const verdictOf = (id: string): { action: string; reason?: string } =>
    id === `service.tracing`
        ? { action: `create`, reason: `declared since the last apply` }
        : id === `app.api`
          ? { action: `update`, reason: `domain changed: api.acme.dev` }
          : { action: `noop` };

const resolveLines = (): IntenticLine[] => [
    { kind: `log`, message: `Reading intent/deploy.config.ts` },
    ...entries.map((entry) => ({ kind: `log`, message: `Resolved ${nodeOf(entry).id}` })),
    { kind: `log`, message: `Wrote intent/desired-state.json` },
    { kind: `result`, envSecrets: [] },
];

const planLines = (): IntenticLine[] => [
    { kind: `log`, message: `Reading the live state of ${entries.length} resources` },
    ...entries.flatMap((entry) => {
        const { id, type } = nodeOf(entry);
        return [
            { kind: `node`, id, type, state: `start` },
            { kind: `node`, id, type, state: `done`, ...verdictOf(id) },
        ];
    }),
    { kind: `result`, orphans: [] },
];

export const intenticRun = ({ args }: { readonly args: readonly string[] }): Frames<IntenticLine> =>
    new Frames((sink) => {
        const [command, verb] = args;
        if (command === `deploy` && verb === `resolve`) {
            return paced(resolveLines(), sink);
        }
        if (command === `deploy` && verb === `plan`) {
            return paced(planLines(), sink);
        }
        return paced([{ kind: `error`, message: `intentic: unknown command "${args.join(` `)}". Try: intentic deploy resolve | plan | apply.` }], sink);
    });

// The apply → adopt job's durable event log, replayed whole to every reader and then followed live, and the terminal
// session it runs in while it runs.
const APPLY_SESSION = `panel-infra-apply`;
let applyLog: IntenticLine[] = [];
let applyRunning = false;
const followers = new Set<StreamSink<IntenticLine>>();

let applyTimer: ReturnType<typeof setInterval> | undefined;

// Closing its terminal kills the job mid-run: the log ends on the exit a killed process leaves.
const killApply = (name: string): boolean => {
    if (name !== APPLY_SESSION || !applyRunning) {
        return false;
    }
    clearInterval(applyTimer);
    applyRunning = false;
    appendApply({ kind: `exit`, command: `apply`, code: 137 });
    for (const sink of followers) {
        sink.close();
    }
    return true;
};

registerTerminalSource(
    () => (applyRunning ? [{ name: APPLY_SESSION, label: `infra apply`, kind: `panel`, running: true, activityAt: Date.now() }] : []),
    killApply,
);

const applyLines = (): IntenticLine[] => {
    const nodes = entries.map(nodeOf).filter(({ id }) => verdictOf(id).action !== `noop`);
    return [
        ...nodes.flatMap(({ id, type }) => [
            { kind: `node`, phase: `apply`, id, type, state: `start`, ...verdictOf(id) },
            { kind: `node`, phase: `apply`, id, type, state: `done`, ...verdictOf(id) },
        ]),
        ...entries
            .filter((entry) => entry.kind !== `backend`)
            .map((entry) => ({ kind: `readiness`, id: nodeOf(entry).id, state: `ready`, url: `https://${String(entry.values[`domain`] ?? `${entry.name}.acme.dev`)}` })),
        { kind: `iteration`, n: 1, converged: true },
        { kind: `result`, converged: true },
        { kind: `exit`, command: `apply`, code: 0 },
        { kind: `log`, message: `Adopting: syncing CI secrets for web and api` },
        { kind: `exit`, command: `adopt`, code: 0 },
    ];
};

const appendApply = (line: IntenticLine): void => {
    applyLog.push(line);
    for (const sink of followers) {
        sink.emit(line);
        if (line[`kind`] === `exit` && line[`command`] === `adopt`) {
            sink.close();
        }
    }
};

export const startApply = (): SandboxHandlerOutput<`intentic`, `apply`> => {
    if (applyRunning) {
        return refuse(`An apply is already running; follow it in its terminal.`, 409);
    }
    applyRunning = true;
    applyLog = [];
    appendApply({ kind: `start` });
    const lines = applyLines();
    applyTimer = setInterval(() => {
        const line = lines.shift();
        if (line === undefined) {
            clearInterval(applyTimer);
            applyRunning = false;
            return;
        }
        appendApply(line);
    }, STEP_MS);
    return { ok: true };
};

export const applyEvents = (): Frames<IntenticLine> =>
    new Frames((sink) => {
        for (const line of applyLog) {
            sink.emit(line);
        }
        if (!applyRunning) {
            sink.close();
            return () => {};
        }
        followers.add(sink);
        return () => followers.delete(sink);
    });
