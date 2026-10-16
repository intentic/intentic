import { type CardDeps, cardRun, type LiveCard, raiseRequest } from "../../guard/card-offers.js";
import { type HeldAnswer, type HeldAsks, type HoldDeps, createHeldAsks } from "../../guard/held-asks.js";
import { wakeWords } from "../../guard/held-cards.js";
import { opt } from "../../opt.js";
import type { ProgramGuard } from "../guards/program-guards.js";

// The one change to a secret's program guard (program-guards.ts) the agent cannot make alone: letting it be typed into
// one more program or phone app unasked, or into a field the program does not mark as a password field. Asked of the
// owner on a card in the live conversation, held like the host guard's own widening card (host-guard-gate.ts): a caller
// that stops waiting leaves it up for the turn's close, and a yes given after that wakes the conversation to ask again.

export interface ProgramGuardGateDeps extends CardDeps {
    // Who may answer; undefined where no owner is recorded, which lets any signed-in person.
    readonly ownerEmail: () => Promise<string | undefined>;
    readonly hold: HoldDeps;
}

export interface ProgramWidenRequest {
    readonly subject: string;
    readonly from: ProgramGuard;
    readonly to: ProgramGuard;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

export type ProgramWidenVerdict = { readonly approvedBy?: string } | { readonly refusal: string };

export interface ProgramGuardGate {
    readonly widen: (request: ProgramWidenRequest) => Promise<ProgramWidenVerdict>;
}

const both = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
const either = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;

// What the change adds, in words: the programs and apps new to the list, and a field rule turned loose.
const additions = (request: ProgramWidenRequest): readonly string[] => {
    const programs = request.to.programs.filter((program) => !request.from.programs.some((held) => held.toLowerCase() === program.toLowerCase()));
    const packages = request.to.packages.filter((pkg) => !request.from.packages.includes(pkg));
    return [...programs, ...packages.map((pkg) => `the ${pkg} app`)];
};

const titleOf = (request: ProgramWidenRequest): string => {
    const added = additions(request);
    const into = added.length === 0 ? "" : ` into ${both(added)}`;
    const field = request.to.anyField && !request.from.anyField ? `${added.length === 0 ? "" : ", and"} into fields not marked as password fields` : "";
    return `Let the agent type ${request.subject}${into}${field} without asking?`;
};

const standing = (request: ProgramWidenRequest): string => {
    const list = [...request.from.programs, ...request.from.packages.map((pkg) => `the ${pkg} app`)];
    const goes = list.length === 0 ? `${request.subject} is typed into no window unasked now.` : `${request.subject} is typed unasked only into ${either(list)} now.`;
    return `${goes} Typing it anywhere else asks the person at that computer first, every time.`;
};

const STILL_WAITING =
    "The card stays up until it is answered. Make exactly the same call again to collect the answer, or carry on with other work and end your turn: if it is allowed after, you are woken to make the call again.";

const askToWiden = async (deps: ProgramGuardGateDeps, card: LiveCard, request: ProgramWidenRequest, ended: AbortSignal): Promise<HeldAnswer<ProgramWidenVerdict>> => {
    const owner = await deps.ownerEmail();
    const raised = await raiseRequest(deps, card, {
        kind: "permission",
        onAbort: { kind: "permission", requestId: "", decision: "deny" },
        raised: (requestId) => ({
            kind: "permission",
            requestId,
            toolName: "secrets.programs",
            title: titleOf(request),
            displayName: "Loosen program guard",
            explain: standing(request),
            reason: "only the owner can loosen a secret's program guard",
        }),
        // The owner's own guard, so only the owner loosens it; checked against the identity verified on the reply.
        mayAnswer: (caller) =>
            owner === undefined || caller?.email.toLowerCase() === owner.toLowerCase() ? undefined : `Only the owner (${owner}) can loosen a secret's program guard.`,
        approves: (reply) => reply.decision !== "deny",
        signal: ended,
    });
    if (raised.decision === "approved") {
        return { answer: raised.caller === undefined ? {} : { approvedBy: raised.caller.email }, outcome: { decision: "approved" } };
    }
    if (raised.decision === "declined") {
        return {
            answer: { refusal: `The owner kept ${request.subject}'s program guard as it is: nothing changed. Do not ask again for the same change.` },
            outcome: { decision: "declined", ...opt("feedback", raised.reply.feedback) },
        };
    }
    return {
        answer: { refusal: "The turn ended before anyone answered, so the guard is unchanged. Say which program the task needed, so the owner can add it on the Secrets view." },
        outcome: { decision: "unanswered" },
    };
};

const widen = async (deps: ProgramGuardGateDeps, asks: HeldAsks<ProgramWidenVerdict>, request: ProgramWidenRequest): Promise<ProgramWidenVerdict> => {
    const card = cardRun(deps, request.conversationId);
    if (card === undefined) {
        return {
            refusal:
                `Only the owner can loosen ${request.subject}'s program guard, and there is no live conversation to ask in. ` +
                "Do not retry: say which program the task needed, so the owner can add it on the Secrets view.",
        };
    }
    const asked = {
        conversationId: card.conversationId,
        key: `${request.subject}\u0000${JSON.stringify(request.to)}`,
        waiting: () => ({
            refusal: `Still waiting for the owner to answer the card asking to loosen ${request.subject}'s program guard; nothing changed yet. ${STILL_WAITING}`,
        }),
        signal: request.signal,
    };
    return (
        asks.reattach(asked) ??
        asks.ask(asked, {
            raise: (ended) => askToWiden(deps, card, request, ended),
            told: wakeWords({
                doing: `loosening ${request.subject}'s program guard`,
                notYet: "Nothing has changed yet",
                again: "Make the same request again now, with the same programs.",
                declinedSo: "the guard is unchanged",
                refrain: "Do not ask again for the same change.",
            }),
            held: deps.hold.held,
            finished: deps.hold.finished(card.conversationId),
        })
    );
};

export const createProgramGuardGate = (deps: ProgramGuardGateDeps): ProgramGuardGate => {
    const asks = createHeldAsks<ProgramWidenVerdict>();
    return { widen: (request) => widen(deps, asks, request) };
};
