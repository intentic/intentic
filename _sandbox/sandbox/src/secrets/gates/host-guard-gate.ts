import type { HostGuardSetting, ProgramAsk, SecretHostGuard } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, type LiveCard, raiseRequest } from "../../guard/card-offers.js";
import { secretSend } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { type HeldAnswer, type HeldAsks, type HoldDeps, createHeldAsks } from "../../guard/held-asks.js";
import { wakeWords } from "../../guard/held-cards.js";
import { opt } from "../../opt.js";
import { type HostReading, type GuardedName, readHosts } from "../host-guards.js";
import type { SecretTarget } from "../secret-access.js";
import { commandDestination, type Destination, pageDestination, SCRIPT_DESTINATION } from "../secret-destinations.js";

// The check every exit makes before a secret's value leaves: where the reference becomes a value, after the command gate
// has had its say and whatever it said. For a secret whose host guard is on, a use whose every named host is on the list
// goes; one aimed off the list, or anywhere its text cannot show, raises a card in the live conversation and waits for a
// person, and is refused when there is nobody to ask. A secret whose guard is off is never asked about here. No judge is
// consulted, so none can let a guarded use through, and none being unreachable does either. The one standing yes is a
// person's own: a card's "Allow <secret> anywhere in this conversation" lets that conversation send it past its guard
// from then on, until it is taken back on the Grants page. A card waits for its answer however long that takes
// (guard/held-asks.ts): a caller that stops waiting leaves it up, held for the turn's close, and a yes given after that
// wakes the conversation to make the same call again.

export interface HostGuardGateDeps extends CardDeps {
    // The guards in force; a rejection (the owner's file exists but cannot be read) refuses rather than lets anything by.
    readonly guards: () => Promise<readonly SecretHostGuard[]>;
    // Who may answer a request to loosen a guard; undefined where no owner is recorded, which lets any signed-in person.
    readonly ownerEmail: () => Promise<string | undefined>;
    // Secrets a conversation may send past their guard, answered on this gate's own card; absent keeps every use asking.
    readonly grants?: SecretPasses;
    readonly hold: HoldDeps;
}

// "Allow <secret> anywhere in this conversation", kept per conversation by registry name.
export interface SecretPasses {
    readonly of: (conversationId: string) => Promise<readonly string[]>;
    readonly add: (conversationId: string, names: readonly string[], by: string | undefined) => Promise<void>;
}

export interface HostGuardCheck {
    // Registry names this use spends (`GITHUB_TOKEN`, `github/token`).
    readonly names: readonly string[];
    readonly target: SecretTarget;
    readonly conversationId: string | undefined;
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
const TO_SEND_FREELY =
    "To use it without a card, keep every host the command names on its list (`secrets hosts` shows it) and let the reader follow where it goes: a curl, wget or git command — piped into a reader like `jq` or `head`, or joined to more by `&&` or `;` — is read, but a script, an interpreter (`python -c`, `node -e`), a subshell, `curl -L`, or a host from a variable filled in as it runs is not (one set to a plain value earlier in the line, `R=https://…; curl $R/x`, is read).";
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

// What a call that stopped waiting on a card reads: nothing happened yet, the card is up, and how to collect its answer.
const STILL_WAITING =
    "The card stays up until it is answered. Make exactly the same call again to collect the answer, or carry on with other work and end your turn: if it is allowed after, you are woken to make the call again.";

const widen = async (deps: HostGuardGateDeps, asks: HeldAsks<WidenVerdict>, request: WidenRequest): Promise<WidenVerdict> => {
    const card = cardRun(deps, request.conversationId);
    // Asked in the conversation whoever started its turn: a card nobody has answered yet waits, and only a call with no
    // live conversation to ask in is refused.
    if (card === undefined) {
        return {
            refusal:
                `Only the owner can loosen ${request.subject}'s host guard, and there is no live conversation to ask in. ` +
                "Do not retry: say which host the task needed, so the owner can add it on the Secrets view.",
        };
    }
    const asked = {
        conversationId: card.conversationId,
        key: `${request.subject}\u0000${JSON.stringify(request.to)}`,
        waiting: () => ({
            refusal: `Still waiting for the owner to answer the card asking to loosen ${request.subject}'s host guard; nothing changed yet. ${STILL_WAITING}`,
        }),
        signal: request.signal,
    };
    return (
        asks.reattach(asked) ??
        asks.ask(asked, {
            raise: (ended) => askToWiden(deps, card, request, ended),
            told: wakeWords({
                doing: `loosening ${request.subject}'s host guard`,
                notYet: "Nothing has changed yet",
                again: "Make the same request again now, with the same hosts.",
                declinedSo: "the guard is unchanged",
                refrain: "Do not ask again for the same change.",
            }),
            held: deps.hold.held,
            finished: deps.hold.finished(card.conversationId),
        })
    );
};

// Raises the widening card and settles with the owner's answer; `ended` settles it unanswered.
const askToWiden = async (deps: HostGuardGateDeps, card: LiveCard, request: WidenRequest, ended: AbortSignal): Promise<HeldAnswer<WidenVerdict>> => {
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
        signal: ended,
    });
    if (raised.decision === "approved") {
        return { answer: raised.caller === undefined ? {} : { approvedBy: raised.caller.email }, outcome: { decision: "approved" } };
    }
    if (raised.decision === "declined") {
        return {
            answer: { refusal: `${declinedOf(request)}: nothing changed. Do not ask again for the same change.` },
            outcome: { decision: "declined", ...opt("feedback", raised.reply.feedback) },
        };
    }
    return {
        answer: {
            refusal: `The turn ended before anyone answered, so the guard is unchanged. Say which host the task needed, so the owner can add it on the Secrets view.`,
        },
        outcome: { decision: "unanswered" },
    };
};

// Whether a person already let this conversation send every one of these past its guard. An unreadable grant file reads
// as no, which asks rather than sends.
const passed = async (deps: HostGuardGateDeps, conversationId: string, names: readonly string[]): Promise<boolean> => {
    if (deps.grants === undefined) {
        return false;
    }
    // allow(silent-catch): an unreadable grant file reads as no grant, which asks a person rather than sends.
    const granted = await deps.grants.of(conversationId).catch((): readonly string[] => []);
    return names.every((name) => granted.includes(name));
};

// The send card for one use: raised, and settled with the person's answer; `ended` settles it unanswered.
const askToSend = async (
    deps: HostGuardGateDeps,
    card: LiveCard,
    input: HostGuardCheck,
    reading: Asked,
    ended: AbortSignal,
): Promise<HeldAnswer<HostGuardVerdict>> => {
    const sentence = sentenceOf(reading, input.target);
    const names = reading.guarded.map((entry) => entry.name);
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
            ...opt("alwaysLabel", deps.grants === undefined ? undefined : `Allow ${both(names)} anywhere in this conversation`),
        }),
        approves: (reply) => reply.decision !== "deny",
        signal: ended,
    });
    if (raised.decision === "unanswered") {
        return {
            answer: refusal(
                sentence,
                "The turn ended before anyone answered, so it was not used. Carry on without it and say what you left undone; ask again only if somebody is around.",
            ),
            outcome: { decision: "unanswered" },
        };
    }
    if (raised.decision === "declined") {
        const feedback = raised.reply.feedback?.trim();
        return {
            answer: refusal(
                sentence,
                feedback || "The person declined: it was not used. Do not retry, and do not look for another way to send it there.",
            ),
            outcome: { decision: "declined", ...opt("feedback", feedback) },
        };
    }
    if (raised.reply.decision === "always") {
        // Kept before the use goes, so the very next one reads it; a write that fails costs only a second card.
        // allow(silent-catch): the person's yes for this use stands either way; a grant not kept only asks again next time.
        await deps.grants?.add(card.conversationId, names, raised.caller?.email).catch(() => undefined);
    }
    return {
        answer: raised.caller === undefined ? { allow: true } : { allow: true, approvedBy: raised.caller.email },
        outcome: { decision: "approved" },
    };
};

// The exact use within its conversation: the same names to the same place by the same text.
const sendKey = (input: HostGuardCheck): string =>
    [input.target.tool, ...input.names, input.target.kind === "page" ? input.target.url : input.target.text].join("\u0000");

export const createHostGuardGate = (deps: HostGuardGateDeps): HostGuardGate => {
    // One registry per kind of card, so a widening never answers a send.
    const widenings = createHeldAsks<WidenVerdict>();
    const sends = createHeldAsks<HostGuardVerdict>();
    return {
        widen: (request) => widen(deps, widenings, request),
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
                canPark: card !== undefined,
            });
            if (verdict.effect === "allow" || reading.destination === "none" || reading.destination === "inside") {
                return { allow: true };
            }
            const sentence = sentenceOf(reading, input.target);
            const names = reading.guarded.map((entry) => entry.name);
            if (card !== undefined && (await passed(deps, card.conversationId, names))) {
                return { allow: true };
            }
            if (verdict.effect === "deny" || card === undefined) {
                return refusal(
                    sentence,
                    `There is no live conversation to ask in: it was not used. Do not retry: carry on without it, and say what you left undone. ${TO_SEND_FREELY}`,
                );
            }
            const asked = {
                conversationId: card.conversationId,
                key: sendKey(input),
                waiting: () => refusal(sentence, `Still waiting for a person to answer the card: it has not been used yet. ${STILL_WAITING}`),
                signal: input.signal,
            };
            return (
                sends.reattach(asked) ??
                sends.ask(asked, {
                    raise: (ended) => askToSend(deps, card, input, reading, ended),
                    told: wakeWords({
                        who: "A person",
                        doing: `sending ${both(names)} past its host guard`,
                        ...opt("call", input.target.kind === "page" ? input.target.url : input.target.text),
                        notYet: "It has not been used yet",
                        again: "Make it now with exactly the same call: the same tool and exactly the same text.",
                        declinedSo: "it was not used",
                        refrain: "Do not retry, and do not look for another way to send it there.",
                    }),
                    held: deps.hold.held,
                    finished: deps.hold.finished(card.conversationId),
                })
            );
        },
    };
};
