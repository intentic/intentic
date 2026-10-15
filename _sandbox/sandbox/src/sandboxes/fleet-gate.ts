import { slugOfHostname } from "@intentic/sandbox-run/slug";
import type { z } from "zod";
import type { DeviceFlowLine, DeviceSandboxFlow } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, type LiveCard, raiseRequest, whyOf } from "../guard/card-offers.js";
import { type HeldAnswer, type HoldDeps, createHeldAsks } from "../guard/held-asks.js";
import { wakeWords } from "../guard/held-cards.js";
import { type CliAnswer, jsonAnswer, refusalAnswer } from "../http/cli-answer.js";
import { SANDBOX_RECOVERY_DAYS } from "@intentic/api-contract";
import { FleetProvisionedSchema, FleetRemovedSchema, FleetSandboxesSchema } from "@intentic/api-contract/ingress";
import { answerError, type FleetSandbox, type ProvisionedSandbox } from "./fleet-client.js";

// CREATING A SANDBOX, the whole path: the owner's card, the platform's claim, the machine's `ic`. And taking one away,
// behind the same card: on the machine that runs it when this sandbox reaches that machine, else the account row alone. Shaped like the
// wallet's payment gate and the capability ask beside it — raised outside the turn generator, because the CLI call is
// HTTP while the turn sits in Bash, and its waiter is that held connection rather than anything journalled.
//
// The order is the point. The card comes BEFORE the claim is minted, so a declined ask costs the account nothing at
// all: no row, no code, nothing to expire. A claim is minted only against a yes, and it is spent immediately.
//
// The card waits for the owner however long that takes (guard/held-asks.ts): a CLI whose connection goes leaves it up,
// held for the turn's close, and a yes given after that wakes the conversation to make the same create again.

// The words on the card's two buttons. Compared verbatim against what comes back, so they are named once.
const APPROVE = "Create it";
const DECLINE = "Not now";

export interface FleetGateDeps extends CardDeps {
    /** The `fleet` capability's provisioning token, read fresh per call so a re-connected token applies at once. */
    readonly token: () => Promise<string | undefined>;
    readonly list: (token: string) => Promise<CliAnswer>;
    readonly provision: (token: string, ask: { name: string; definition?: string }) => Promise<CliAnswer>;
    /** The machines this sandbox can reach, and which of them runs this sandbox (undefined when unread, not "none"). */
    readonly devices: () => Promise<{ readonly ids: readonly string[]; readonly self: string | undefined }>;
    readonly runFlow: (id: string, flow: DeviceSandboxFlow) => AsyncGenerator<DeviceFlowLine>;
    readonly hold: HoldDeps;
    /** Moves one of the account's sandboxes to its trash, by the id the list names. */
    readonly remove: (token: string, sandboxId: string) => Promise<CliAnswer>;
    /** The connected machine a sandbox runs on, by its slug, from readings already held; undefined is "not known here". */
    readonly runsOn: (slug: string) => Promise<string | undefined>;
    /** This sandbox's own public address, so it is never the one taken away from inside itself. */
    readonly selfUrl: () => string;
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
// Read the run contract's way, lowercased as `ic sandbox connect` names the container.
export const slugOf = (hostname: string): string => slugOfHostname(hostname) ?? "";

// A platform body read through its route's own schema, or undefined when it is not that.
const bodyAs = <T>(schema: z.ZodType<T>, body: string): T | undefined => {
    try {
        return schema.safeParse(JSON.parse(body)).data;
    } catch {
        // allow(silent-catch): a body that is not JSON (a proxy's 502 page) reads as none, which every caller refuses by name.
        return undefined;
    }
};

const provisionedFrom = (body: string): ProvisionedSandbox | undefined => bodyAs(FleetProvisionedSchema, body);

// Which machine builds it. Naming one that is not connected is refused rather than silently redirected: "somewhere
// else entirely" is never what the asker meant.
const machineFor = async (deps: FleetGateDeps, on: string | undefined): Promise<{ readonly id: string } | CliAnswer> => {
    const { ids, self } = await deps.devices();
    if (on !== undefined) {
        return ids.includes(on)
            ? { id: on }
            : refusalAnswer(
                  409,
                  "no_such_device",
                  `"${on}" is not a computer this sandbox can reach. Connected right now: ${ids.join(", ") || "none"}.`,
              );
    }
    const only = ids.length === 1 ? ids[0] : undefined;
    const chosen = self ?? only;
    if (chosen === undefined) {
        return refusalAnswer(
            409,
            "no_device",
            ids.length === 0
                ? 'A new sandbox has to run on one of the owner\'s computers, and none is connected. Ask for one: `capabilities request host --why "..."`.'
                : `Several computers are connected (${ids.join(", ")}) and none of them is known to run this sandbox. Name one with --on.`,
        );
    }
    return { id: chosen };
};

// What picking the create means, then the agent's case for it, capped as every card caps it. The case rides on the
// choice it argues for because the question card draws an option's label, description and preview and nothing else.
const withCase = (means: string, why: string | undefined): string => {
    const agentsCase = whyOf(why).why;
    return agentsCase === undefined ? means : `${means} The agent's case: ${agentsCase}`;
};

const approveDescription = (machineId: string, why: string | undefined): string =>
    withCase(`Makes it on your intentic account and brings it up on ${machineId}. It is yours, and it outlives this conversation.`, why);

// One card the owner answers before the account is touched: what it asks, its two buttons, and the words for each way
// of not getting a yes. The create and the removal differ only in these.
interface OwnerCard {
    // The exact ask, so a yes given after the CLI stopped waiting is spent once, on that ask.
    readonly key: string;
    readonly question: string;
    readonly header: string;
    readonly approve: { readonly label: string; readonly description: string };
    readonly decline: { readonly label: string; readonly description: string };
    // The refusal a call that stopped waiting gets while the card stays up.
    readonly waiting: string;
    readonly declined: string;
    readonly unanswered: string;
    readonly told: Parameters<typeof wakeWords>[0];
}

// The open cards, by the exact ask, so a yes given after the CLI stopped waiting acts once.
const creates = createHeldAsks<CliAnswer | undefined>();
const removals = createHeldAsks<CliAnswer | undefined>();

// The owner's decision, as the only thing standing between an agent and a change to their account. Undefined is a
// yes; anything else is the refusal to answer with, worded for whichever way it was not a yes.
const askOwner = async (
    deps: FleetGateDeps,
    where: { readonly conversationId: string | undefined; readonly signal: AbortSignal },
    held: ReturnType<typeof createHeldAsks<CliAnswer | undefined>>,
    card: OwnerCard,
): Promise<CliAnswer | undefined> => {
    const run = cardRun(deps, where.conversationId);
    if (run === undefined) {
        return refusalAnswer(
            409,
            "no_conversation",
            "There is no live conversation to raise the card in, and the account is never changed without one.",
        );
    }
    const asked = {
        conversationId: run.conversationId,
        key: card.key,
        waiting: () => refusalAnswer(409, "awaiting_owner", card.waiting),
        signal: where.signal,
    };
    return (
        held.reattach(asked) ??
        held.ask(asked, {
            raise: (ended) => cardFor(deps, run, card, ended),
            told: wakeWords(card.told),
            held: deps.hold.held,
            finished: deps.hold.finished(run.conversationId),
        })
    );
};

// Raises the card and settles with the owner's answer; `ended` settles it unanswered.
const cardFor = async (deps: FleetGateDeps, run: LiveCard, card: OwnerCard, ended: AbortSignal): Promise<HeldAnswer<CliAnswer | undefined>> => {
    const answered = await raiseRequest(deps, run, {
        kind: "question",
        onAbort: { kind: "question", requestId: "", cancelled: true },
        raised: (requestId) => ({
            kind: "question",
            requestId,
            questions: [{ question: card.question, header: card.header, multiSelect: false, options: [card.approve, card.decline] }],
        }),
        // Approval is the exact label coming back, never a truthy answer: an unanswered card and a dismissed one both
        // arrive with no answers at all, and neither is a yes.
        approves: (reply) =>
            Object.values(reply.answers ?? {})
                .flat()
                .includes(card.approve.label),
        signal: ended,
    });
    switch (answered.decision) {
        case "approved":
            return { answer: undefined, outcome: { decision: "approved" } };
        case "declined":
            return { answer: refusalAnswer(409, "declined", card.declined), outcome: { decision: "declined" } };
        case "unanswered":
            return { answer: refusalAnswer(408, "unanswered", card.unanswered), outcome: { decision: "unanswered" } };
    }
};

const createCard = (ask: CreateAsk, machineId: string): OwnerCard => ({
    key: [ask.name, machineId, ask.definition ?? ""].join("\u0000"),
    question: `Create a new sandbox "${ask.name}" on ${machineId}?`,
    header: "New sandbox",
    approve: { label: APPROVE, description: approveDescription(machineId, ask.why) },
    decline: { label: DECLINE, description: "Nothing is created and nothing is spent." },
    waiting:
        `Still waiting for the owner: a card asks them to create "${ask.name}", and nothing has been created yet. The card stays up until they answer. ` +
        "Make exactly the same call again to collect their answer, or carry on with other work and end your turn: if they say yes after, you are woken to make the call again.",
    declined: `The owner did not want that sandbox created. Carry on without it, and do not ask again for "${ask.name}".`,
    unanswered: "The turn ended before the owner answered: nothing was created. Continue without it.",
    told: {
        doing: `creating the sandbox "${ask.name}" on ${machineId}`,
        notYet: "Nothing has been created yet",
        again: "Make the same call now, with the same name, machine and definition.",
        declinedSo: "nothing was created",
        refrain: `Carry on without it, and do not ask again for "${ask.name}".`,
    },
});

// `ic sandbox connect` on the chosen machine, narrated. Every line it printed rides back whether it worked or not:
// this flow fails in a hundred machine-specific ways, and `ic`'s own account of one is worth more than any sentence
// written here about it.
const buildOn = async (deps: FleetGateDeps, machineId: string, sandbox: ProvisionedSandbox): Promise<CliAnswer> => {
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
        return jsonAnswer(502, {
            error: {
                type: "build_failed",
                message: `"${sandbox.name}" was created on the account but could not be brought up on ${machineId}: ${failure}`,
            },
            sandboxId: sandbox.sandboxId,
            name: sandbox.name,
            lines,
        });
    }
    return jsonAnswer(200, { sandboxId: sandbox.sandboxId, name: sandbox.name, slug, url: `https://${sandbox.hostname}`, on: machineId, lines });
};

export const createSandboxThroughFleet = async (deps: FleetGateDeps, ask: CreateAsk): Promise<CliAnswer> => {
    const token = await deps.token();
    if (token === undefined || token === "") {
        return refusalAnswer(409, "no_fleet", NO_CAPABILITY);
    }
    const machine = await machineFor(deps, ask.on);
    if (!("id" in machine)) {
        return machine;
    }
    const refused = await askOwner(deps, ask, creates, createCard(ask, machine.id));
    if (refused !== undefined) {
        return refused;
    }
    const minted = await deps.provision(token, { name: ask.name, ...(ask.definition === undefined ? {} : { definition: ask.definition }) });
    if (minted.status !== 200) {
        return refusalAnswer(502, "provision_failed", `The platform would not create that sandbox: ${answerError(minted)}`);
    }
    const sandbox = provisionedFrom(minted.body);
    return sandbox === undefined
        ? refusalAnswer(502, "provision_failed", "The platform's answer to the provision was unreadable; nothing was built.")
        : await buildOn(deps, machine.id, sandbox);
};

/** Every sandbox on the owner's account. A plain read: no card, since listing changes nothing. */
export const listFleet = async (deps: Pick<FleetGateDeps, "token" | "list">): Promise<CliAnswer> => {
    const token = await deps.token();
    if (token === undefined || token === "") {
        return refusalAnswer(409, "no_fleet", NO_CAPABILITY);
    }
    const listed = await deps.list(token);
    return listed.status === 200
        ? { status: 200, body: listed.body, contentType: "application/json" }
        : refusalAnswer(502, "list_failed", `The account's sandboxes could not be read: ${answerError(listed)}`);
};

export interface RemoveAsk {
    /** The sandbox's name on the account, or its id there. */
    readonly name: string;
    readonly why: string | undefined;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

const REMOVE = "Remove it";
const KEEP = "Keep it";

const hostOf = (url: string): string => url.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/:?#].*$/, "");

const sandboxesOf = (body: string): readonly FleetSandbox[] => bodyAs(FleetSandboxesSchema, body)?.sandboxes ?? [];

// Where the removal happens. A container on a machine this sandbox reaches is removed there, which takes it off the
// account as well and keeps its files for the recovery window; anything else is the account row alone, and a container
// out of reach is left running wherever it is, which the card says before the press.
type Removal =
    | { readonly kind: "machine"; readonly machine: string; readonly slug: string }
    | { readonly kind: "account"; readonly cameUp: boolean };

const removalOf = async (deps: FleetGateDeps, sandbox: FleetSandbox): Promise<Removal> => {
    const slug = sandbox.url === undefined ? "" : slugOf(hostOf(sandbox.url));
    const machine = slug === "" ? undefined : await deps.runsOn(slug);
    return machine === undefined ? { kind: "account", cameUp: sandbox.url !== undefined } : { kind: "machine", machine, slug };
};

const removalMeans = (removal: Removal): string => {
    if (removal.kind === "machine") {
        return (
            `Removes its container on ${removal.machine} and takes it off your account. Its files and history stay on ${removal.machine} ` +
            `for ${SANDBOX_RECOVERY_DAYS} days, and \`ic sandbox restore ${removal.slug}\` there brings it back.`
        );
    }
    return removal.cameUp
        ? `Takes it off your account, and its address stops working. Its container is on no machine this sandbox reaches, so it is left running there until you remove it. Recently deleted brings the sandbox back for ${SANDBOX_RECOVERY_DAYS} days.`
        : `It never came up, so there is no container: it leaves your account, and Recently deleted brings it back for ${SANDBOX_RECOVERY_DAYS} days.`;
};

const removeCard = (ask: RemoveAsk, sandbox: FleetSandbox, removal: Removal): OwnerCard => ({
    key: [sandbox.id, removal.kind].join("\u0000"),
    question: `Remove the sandbox "${sandbox.name}"?`,
    header: "Remove",
    approve: { label: REMOVE, description: withCase(removalMeans(removal), ask.why) },
    decline: { label: KEEP, description: "Nothing is removed." },
    waiting:
        `Still waiting for the owner: a card asks them to remove "${sandbox.name}", and nothing has been removed yet. The card stays up until they answer. ` +
        "Make exactly the same call again to collect their answer, or carry on and end your turn: if they say yes after, you are woken to make the call again.",
    declined: `The owner wants "${sandbox.name}" kept. Leave it, and do not ask again to remove it.`,
    unanswered: "The turn ended before the owner answered: nothing was removed.",
    told: {
        doing: `removing the sandbox "${sandbox.name}"`,
        notYet: "Nothing has been removed yet",
        again: "Make the same call now, with the same name.",
        declinedSo: "nothing was removed",
        refrain: `Leave it, and do not ask again to remove "${sandbox.name}".`,
    },
});

// `ic sandbox remove` on the machine, narrated as a create is: what the machine printed is the report.
const removeOn = async (deps: FleetGateDeps, sandbox: FleetSandbox, removal: Extract<Removal, { kind: "machine" }>): Promise<CliAnswer> => {
    const lines: string[] = [];
    let failure: string | undefined;
    for await (const line of deps.runFlow(removal.machine, { op: "remove", slug: removal.slug })) {
        if (line.kind === "error") {
            failure = line.message;
        }
        lines.push(line.kind === "line" ? line.text : line.message);
    }
    if (failure !== undefined) {
        return jsonAnswer(502, {
            error: { type: "remove_failed", message: `"${sandbox.name}" could not be removed on ${removal.machine}: ${failure}` },
            lines,
        });
    }
    return jsonAnswer(200, {
        name: sandbox.name,
        removed: "machine",
        on: removal.machine,
        restore: `ic sandbox restore ${removal.slug}, on ${removal.machine}, within ${SANDBOX_RECOVERY_DAYS} days`,
        lines,
    });
};

const removeRow = async (deps: FleetGateDeps, token: string, sandbox: FleetSandbox): Promise<CliAnswer> => {
    const removed = await deps.remove(token, sandbox.id);
    if (removed.status !== 200) {
        return refusalAnswer(502, "remove_failed", `The platform would not remove "${sandbox.name}": ${answerError(removed)}`);
    }
    const said = bodyAs(FleetRemovedSchema, removed.body);
    return jsonAnswer(
        200,
        said === undefined ? { name: sandbox.name, removed: "account" } : { name: sandbox.name, removed: "account", recoverableUntil: said.recoverableUntil },
    );
};

/**
 * Takes one of the account's sandboxes away, the owner's card first. Never the sandbox this runs in, and never a
 * guess between two of one name.
 */
export const removeSandboxThroughFleet = async (deps: FleetGateDeps, ask: RemoveAsk): Promise<CliAnswer> => {
    const token = await deps.token();
    if (token === undefined || token === "") {
        return refusalAnswer(409, "no_fleet", NO_CAPABILITY);
    }
    const listed = await deps.list(token);
    if (listed.status !== 200) {
        return refusalAnswer(502, "list_failed", `The account's sandboxes could not be read: ${answerError(listed)}`);
    }
    const all = sandboxesOf(listed.body);
    const asked = ask.name.trim();
    const matches = all.filter((sandbox) => sandbox.id === asked || sandbox.name.toLowerCase() === asked.toLowerCase());
    const [sandbox, ...more] = matches;
    if (sandbox === undefined) {
        return refusalAnswer(
            404,
            "no_such_sandbox",
            `No sandbox on the account is called "${asked}". On it: ${all.map((entry) => `"${entry.name}"`).join(", ") || "none"}.`,
        );
    }
    if (more.length > 0) {
        return refusalAnswer(
            409,
            "ambiguous",
            `${matches.length} sandboxes are called "${asked}" (${matches.map((entry) => entry.id).join(", ")}): name the one to remove by its id.`,
        );
    }
    if (sandbox.url !== undefined && deps.selfUrl() !== "" && hostOf(sandbox.url) === hostOf(deps.selfUrl())) {
        return refusalAnswer(
            409,
            "self",
            `"${sandbox.name}" is this sandbox, the one this conversation runs in: it is never removed from inside itself. Its owner removes it in the app.`,
        );
    }
    const removal = await removalOf(deps, sandbox);
    const refused = await askOwner(deps, ask, removals, removeCard(ask, sandbox, removal));
    if (refused !== undefined) {
        return refused;
    }
    return removal.kind === "machine" ? removeOn(deps, sandbox, removal) : removeRow(deps, token, sandbox);
};
