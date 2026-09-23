import type { DeviceFlowLine, DeviceSandboxFlow } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseRequest, whyOf } from "../agents/actor/card-offers.js";
import type { RelayedAnswer } from "../platform/platform-relay.js";
import { answerError, type ProvisionedSandbox } from "./fleet-client.js";

// CREATING A SANDBOX, the whole path: the owner's card, the platform's claim, the machine's `ic`. Shaped like the
// wallet's payment gate and the capability ask beside it — raised outside the turn generator, because the CLI call is
// HTTP while the turn sits in Bash, and its waiter is that held connection rather than anything journalled.
//
// The order is the point. The card comes BEFORE the claim is minted, so a declined ask costs the account nothing at
// all: no row, no code, nothing to expire. A claim is minted only against a yes, and it is spent immediately.

// Terminal-shaped answer triple, the same shape the capability ask and the platform relays use, so the CLI prints
// every outcome the same way.
export interface FleetAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

const answer = (status: number, payload: unknown): FleetAnswer => ({ status, body: JSON.stringify(payload), contentType: "application/json" });
const refusal = (status: number, type: string, message: string): FleetAnswer => answer(status, { error: { type, message } });

// The words on the card's two buttons. Compared verbatim against what comes back, so they are named once.
const APPROVE = "Create it";
const DECLINE = "Not now";

export interface FleetGateDeps extends CardDeps {
    /** The `fleet` capability's provisioning token, read fresh per call so a re-connected token applies at once. */
    readonly token: () => Promise<string | undefined>;
    readonly list: (token: string) => Promise<RelayedAnswer>;
    readonly provision: (token: string, ask: { name: string; definition?: string }) => Promise<RelayedAnswer>;
    /** The machines this sandbox can reach, and which of them runs this sandbox (undefined when unread, not "none"). */
    readonly devices: () => Promise<{ readonly ids: readonly string[]; readonly self: string | undefined }>;
    readonly runFlow: (id: string, flow: DeviceSandboxFlow) => AsyncGenerator<DeviceFlowLine>;
    readonly deadlineMs?: number;
}

export interface CreateAsk {
    readonly name: string;
    /** Which connected machine to build it on; left out, the one this sandbox runs on. */
    readonly on: string | undefined;
    readonly definition: string | undefined;
    readonly why: string | undefined;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

const NO_CAPABILITY =
    'This sandbox is not connected to your intentic account, so it cannot create sandboxes on it. Ask the owner to connect one: `capabilities request fleet --why "..."`.';

// A sandbox's slug is the first label of the public hostname the platform minted for it, and that is also the name
// docker will know its container by — which is what the device has to check is free before spending the claim.
export const slugOf = (hostname: string): string => hostname.split(".")[0] ?? "";

const provisionedFrom = (body: string): ProvisionedSandbox | undefined => {
    try {
        const parsed = JSON.parse(body) as Partial<ProvisionedSandbox>;
        return typeof parsed.setupCode === "string" && typeof parsed.hostname === "string" && typeof parsed.sandboxId === "string"
            ? {
                  sandboxId: parsed.sandboxId,
                  name: typeof parsed.name === "string" ? parsed.name : "",
                  hostname: parsed.hostname,
                  setupCode: parsed.setupCode,
                  expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : "",
              }
            : undefined;
    } catch {
        return undefined;
    }
};

// Which machine builds it. Naming one that is not connected is refused rather than silently redirected: "somewhere
// else entirely" is never what the asker meant.
const machineFor = async (deps: FleetGateDeps, on: string | undefined): Promise<{ readonly id: string } | FleetAnswer> => {
    const { ids, self } = await deps.devices();
    if (on !== undefined) {
        return ids.includes(on)
            ? { id: on }
            : refusal(409, "no_such_device", `"${on}" is not a computer this sandbox can reach. Connected right now: ${ids.join(", ") || "none"}.`);
    }
    const only = ids.length === 1 ? ids[0] : undefined;
    const chosen = self ?? only;
    if (chosen === undefined) {
        return refusal(
            409,
            "no_device",
            ids.length === 0
                ? 'A new sandbox has to run on one of the owner\'s computers, and none is connected. Ask for one: `capabilities request host --why "..."`.'
                : `Several computers are connected (${ids.join(", ")}) and none of them is known to run this sandbox. Name one with --on.`,
        );
    }
    return { id: chosen };
};

// The owner's decision, as the only thing standing between an agent and a sandbox on their account. Undefined is a
// yes; anything else is the refusal to answer with, worded for whichever way it was not a yes.
const askOwner = async (deps: FleetGateDeps, ask: CreateAsk, machineId: string): Promise<FleetAnswer | undefined> => {
    const run = cardRun(deps, ask.conversationId);
    if (run === undefined) {
        return refusal(409, "no_conversation", "There is no live conversation to raise the card in, and a sandbox is never created without one.");
    }
    const card = await raiseRequest(deps, run, {
        kind: "question",
        onAbort: { kind: "question", requestId: "", cancelled: true },
        raised: (requestId) => ({
            kind: "question",
            requestId,
            questions: [
                {
                    question: `Create a new sandbox "${ask.name}" on ${machineId}?`,
                    header: "New sandbox",
                    multiSelect: false,
                    options: [
                        {
                            label: APPROVE,
                            description: `Makes it on your intentic account and brings it up on ${machineId}. It is yours, and it outlives this conversation.`,
                            ...whyOf(ask.why),
                        },
                        { label: DECLINE, description: "Nothing is created and nothing is spent." },
                    ],
                },
            ],
        }),
        signal: ask.signal,
        deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
    });
    // Approval is the exact label coming back, never a truthy answer: an unanswered card and a dismissed one both
    // arrive with no answers at all, and neither is a yes.
    const chose = Object.values(card.reply.answers ?? {}).flat();
    return chose.includes(APPROVE)
        ? undefined
        : card.answered
          ? refusal(409, "declined", `The owner did not want that sandbox created. Carry on without it, and do not ask again for "${ask.name}".`)
          : refusal(408, "unanswered", "The ask went unanswered and expired: nothing was created. Continue without it.");
};

// `ic sandbox connect` on the chosen machine, narrated. Every line it printed rides back whether it worked or not:
// this flow fails in a hundred machine-specific ways, and `ic`'s own account of one is worth more than any sentence
// written here about it.
const buildOn = async (deps: FleetGateDeps, machineId: string, sandbox: ProvisionedSandbox): Promise<FleetAnswer> => {
    const slug = slugOf(sandbox.hostname);
    const lines: string[] = [];
    let failure: string | undefined;
    for await (const line of deps.runFlow(machineId, { op: "create", slug, setupCode: sandbox.setupCode })) {
        if (line.kind === "error") {
            failure = line.message;
        }
        lines.push(line.kind === "line" ? line.text : line.message);
    }
    if (failure !== undefined) {
        // The row exists and the claim is what expires, so the honest report is that the NAME is taken and the build
        // is what failed — otherwise the next attempt picks the same name and meets the device's own refusal.
        return answer(502, {
            error: {
                type: "build_failed",
                message: `"${sandbox.name}" was created on the account but could not be brought up on ${machineId}: ${failure}`,
            },
            sandboxId: sandbox.sandboxId,
            name: sandbox.name,
            lines,
        });
    }
    return answer(200, { sandboxId: sandbox.sandboxId, name: sandbox.name, slug, url: `https://${sandbox.hostname}`, on: machineId, lines });
};

export const createSandboxThroughFleet = async (deps: FleetGateDeps, ask: CreateAsk): Promise<FleetAnswer> => {
    const token = await deps.token();
    if (token === undefined || token === "") {
        return refusal(409, "no_fleet", NO_CAPABILITY);
    }
    const machine = await machineFor(deps, ask.on);
    if (!("id" in machine)) {
        return machine;
    }
    const refused = await askOwner(deps, ask, machine.id);
    if (refused !== undefined) {
        return refused;
    }
    const minted = await deps.provision(token, { name: ask.name, ...(ask.definition === undefined ? {} : { definition: ask.definition }) });
    if (minted.status !== 200) {
        return refusal(502, "provision_failed", `The platform would not create that sandbox: ${answerError(minted)}`);
    }
    const sandbox = provisionedFrom(minted.body);
    return sandbox === undefined
        ? refusal(502, "provision_failed", "The platform's answer to the provision was unreadable; nothing was built.")
        : await buildOn(deps, machine.id, sandbox);
};

/** Every sandbox on the owner's account. A plain read: no card, since listing changes nothing. */
export const listFleet = async (deps: Pick<FleetGateDeps, "token" | "list">): Promise<FleetAnswer> => {
    const token = await deps.token();
    if (token === undefined || token === "") {
        return refusal(409, "no_fleet", NO_CAPABILITY);
    }
    const listed = await deps.list(token);
    return listed.status === 200
        ? { status: 200, body: listed.body, contentType: "application/json" }
        : refusal(502, "list_failed", `The account's sandboxes could not be read: ${answerError(listed)}`);
};
