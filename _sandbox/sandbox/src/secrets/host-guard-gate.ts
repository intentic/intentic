import type { HostGuardSetting, ProgramAsk, SecretHostGuard } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseRequest } from "../conversations/actor/card-offers.js";
import { secretSend } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { opt } from "../opt.js";
import { type HostReading, type GuardedName, readHosts } from "./host-guards.js";
import type { SecretTarget } from "./secret-access.js";
import { commandDestination, type Destination, pageDestination, SCRIPT_DESTINATION } from "./secret-destinations.js";

// The check every exit makes before a secret's value leaves: where the reference becomes a value, after the command gate
// has had its say and whatever it said. For a secret whose host guard is on, a use whose every named host is on the list
// goes; one aimed off the list, or anywhere its text cannot show, raises a card in the live conversation and waits for a
// person, and is refused when there is nobody to ask. A secret whose guard is off is never asked about here. No judge is
// consulted, so none can let a guarded use through, and none being unreachable does either.

export interface HostGuardGateDeps extends CardDeps {
    // The guards in force; a rejection (the owner's file exists but cannot be read) refuses rather than lets anything by.
    readonly guards: () => Promise<readonly SecretHostGuard[]>;
    // Who may answer a request to loosen a guard; undefined where no owner is recorded, which lets any signed-in person.
    readonly ownerEmail: () => Promise<string | undefined>;
    // Whether nobody is at the conversation's composer; a request to loosen is refused there rather than left parked.
    readonly unattended: (conversationId: string) => boolean;
    readonly deadlineMs?: number;
}

export interface HostGuardCheck {
    // Registry names this use spends (`GITHUB_TOKEN`, `github/token`).
    readonly names: readonly string[];
    readonly target: SecretTarget;
    readonly conversationId: string | undefined;
    readonly unattended: boolean;
    readonly signal: AbortSignal;
}

export type HostGuardVerdict = { readonly allow: true; readonly approvedBy?: string } | { readonly allow: false; readonly reason: string };

// The agent asking the owner to loosen a secret's guard, by a host (`secrets hosts … add`) or off (`secrets hosts … off`):
// the one change to a guard it cannot make alone.
export interface WidenRequest {
    readonly subject: string;
    // The guard in force now, and the one asked for.
    readonly from: HostGuardSetting;
    readonly to: HostGuardSetting;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

export type WidenVerdict = { readonly approvedBy?: string } | { readonly refusal: string };

export interface HostGuardGate {
    readonly check: (input: HostGuardCheck) => Promise<HostGuardVerdict>;
    readonly widen: (input: WidenRequest) => Promise<WidenVerdict>;
}

// How much of the program the card shows, the command gate's own measure.
const SHOWN = 400;

const destinationOf = (target: SecretTarget): Destination => {
    if (target.kind === "page") {
        return pageDestination(target.url);
    }
    return target.language === "bash" ? commandDestination(target.text) : SCRIPT_DESTINATION;
};

const nounOf = (target: SecretTarget): string => (target.kind === "page" ? "page" : target.language === "bash" ? "command" : "script");

// "a", "a or b", "a, b or c": every host written out, since "one of 3 hosts" gives nobody anything to check.
const either = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
const both = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

// Each guarded secret's list, in one clause.
const listOf = (entry: GuardedName): string =>
    entry.hosts.length === 0
        ? `${entry.name}'s host guard asks before every use`
        : `${entry.name}'s host guard lets it go unasked only to ${either(entry.hosts)}`;
const listsOf = (guarded: readonly GuardedName[]): string => guarded.map(listOf).join("; ");

type Asked = Exclude<HostReading, { readonly destination: "none" | "inside" }>;

// What the card and the refusal both say: the lists, then what this use does against them.
const sentenceOf = (reading: Asked, target: SecretTarget): string => {
    const noun = nounOf(target);
    const them = reading.guarded.length === 1 ? "it" : "them";
    if (reading.destination === "outside") {
        return target.kind === "page"
            ? `${listsOf(reading.guarded)}, and this page is on ${both(reading.hosts)}.`
            : `${listsOf(reading.guarded)}, and this ${noun} would send ${them} to ${both(reading.hosts)}.`;
    }
    return `${listsOf(reading.guarded)}, and where this ${noun} sends ${them} cannot be read from it: ${reading.why}.`;
};

const titleOf = (reading: Asked, target: SecretTarget): string => {
    const names = both(reading.guarded.map((entry) => entry.name));
    if (reading.destination === "outside") {
        return target.kind === "page" ? `Type ${names} into a page on ${both(reading.hosts)}?` : `Send ${names} to ${both(reading.hosts)}?`;
    }
    return `Send ${names} where its host guard can't check?`;
};

// Every place `token` sits in `text`, as spans; a reference token never overlaps itself.
const occurrences = (text: string, token: string): { readonly start: number; readonly end: number }[] => {
    const found: { readonly start: number; readonly end: number }[] = [];
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) {
        found.push({ start: at, end: at + token.length });
    }
    return found;
};

// The program the card holds, with every guarded reference marked: the part the card is about.
const programAskOf = (target: SecretTarget, guarded: readonly GuardedName[]): ProgramAsk | undefined => {
    if (target.kind === "page") {
        return undefined;
    }
    const text = target.text.slice(0, SHOWN);
    const spans = guarded.flatMap((entry) => occurrences(text, `{{secret:${entry.name}}}`)).toSorted((left, right) => left.start - right.start);
    return { text, language: target.language, truncated: target.text.length > SHOWN, spans };
};

// What the agent reads for each way a card can end, and for having nobody to ask.
const TO_SEND_FREELY = "To use it without a card, write one curl, wget or git command whose every URL is on its list (`secrets hosts` shows it).";
const refusal = (sentence: string, ending: string): HostGuardVerdict => ({ allow: false, reason: `${sentence} ${ending}` });

// The card's question, and what a no leaves standing: turning the guard off, or adding hosts to it.
const wideningTitle = (request: WidenRequest): string => {
    if (!request.to.guard) {
        return `Turn off ${request.subject}'s host guard, so the agent may send it anywhere?`;
    }
    const added = request.to.hosts.filter((host) => !request.from.hosts.includes(host));
    return `Let the agent also send ${request.subject} to ${both(added)} without asking?`;
};
const declinedOf = (request: WidenRequest): string =>
    request.to.guard ? `The owner kept those hosts off ${request.subject}'s host guard` : `The owner kept ${request.subject}'s host guard on`;

// The guard as it stands, for the card's explanation.
const standing = (request: WidenRequest): string =>
    request.from.hosts.length === 0
        ? `${request.subject}'s host guard asks before every use now.`
        : `${request.subject}'s host guard lets it go unasked only to ${either(request.from.hosts)} now. Anything else asks first, every time.`;

const widen = async (deps: HostGuardGateDeps, request: WidenRequest): Promise<WidenVerdict> => {
    const card = cardRun(deps, request.conversationId);
    if (card === undefined || deps.unattended(card.conversationId)) {
        return {
            refusal:
                `Only the owner can loosen ${request.subject}'s host guard, and there is nobody here to ask. ` +
                "Do not retry: say which host the task needed, so the owner can add it on the Secrets view.",
        };
    }
    const owner = await deps.ownerEmail();
    const raised = await raiseRequest(deps, card, {
        kind: "permission",
        onAbort: { kind: "permission", requestId: "", decision: "deny" },
        raised: (requestId) => ({
            kind: "permission",
            requestId,
            toolName: "secrets.hosts",
            title: wideningTitle(request),
            displayName: "Loosen host guard",
            explain: standing(request),
            reason: "only the owner can loosen a secret's host guard",
        }),
        // The owner's own guard, so only the owner loosens it; checked against the identity verified on the reply.
        mayAnswer: (caller) =>
            owner === undefined || caller?.email.toLowerCase() === owner.toLowerCase()
                ? undefined
                : `Only the owner (${owner}) can loosen a secret's host guard.`,
        approves: (reply) => reply.decision !== "deny",
        signal: request.signal,
        deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
    });
    if (raised.decision === "approved") {
        return raised.caller === undefined ? {} : { approvedBy: raised.caller.email };
    }
    return {
        refusal:
            raised.decision === "declined"
                ? `${declinedOf(request)}: nothing changed. Do not ask again for the same change.`
                : `Nobody answered, so the guard is unchanged. Say which host the task needed, so the owner can add it on the Secrets view.`,
    };
};

export const createHostGuardGate = (deps: HostGuardGateDeps): HostGuardGate => ({
    widen: (request) => widen(deps, request),
    check: async (input) => {
        let reading: HostReading;
        try {
            reading = readHosts(await deps.guards(), input.names, destinationOf(input.target));
        } catch {
            return {
                allow: false,
                reason:
                    "The secret could not be used: the owner's secret host guards could not be read, so it was refused rather than sent on a guess. " +
                    "Do not retry: tell the owner their secret host guards are unreadable.",
            };
        }
        const card = cardRun(deps, input.conversationId);
        const verdict = guard(secretSend, {
            guarded: reading.destination !== "none",
            destination: reading.destination === "none" ? "inside" : reading.destination,
            unattended: input.unattended,
            canPark: card !== undefined,
        });
        if (verdict.effect === "allow" || reading.destination === "none" || reading.destination === "inside") {
            return { allow: true };
        }
        const sentence = sentenceOf(reading, input.target);
        if (verdict.effect === "deny" || card === undefined) {
            const nobody = input.unattended ? "This turn is running unattended, so nobody can approve it" : "There is no live conversation to ask in";
            return refusal(
                sentence,
                `${nobody}: it was not used. Do not retry: carry on without it, and say what you left undone. ${TO_SEND_FREELY}`,
            );
        }
        const program = programAskOf(input.target, reading.guarded);
        const raised = await raiseRequest(deps, card, {
            kind: "permission",
            // `deny` in the abort stand-in reads a stopped turn as "not sent", never as a yes nobody gave.
            onAbort: { kind: "permission", requestId: "", decision: "deny" },
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: input.target.tool,
                title: titleOf(reading, input.target),
                displayName: "Send secret",
                ...opt("program", program),
                explain: sentence,
            }),
            approves: (reply) => reply.decision !== "deny",
            signal: input.signal,
            deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
        });
        if (raised.decision === "unanswered") {
            return refusal(
                sentence,
                "Nobody answered, so it was not used. Carry on without it and say what you left undone; ask again only if somebody is around.",
            );
        }
        if (raised.decision === "declined") {
            return refusal(
                sentence,
                raised.reply.feedback?.trim() ||
                    "The person declined: it was not used. Do not retry, and do not look for another way to send it there.",
            );
        }
        return raised.caller === undefined ? { allow: true } : { allow: true, approvedBy: raised.caller.email };
    },
});
