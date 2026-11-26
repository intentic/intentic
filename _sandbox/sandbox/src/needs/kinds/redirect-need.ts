import { createHash } from "node:crypto";
import { type Need, type NeedAsk, type NeedSubject, REDIRECT_WORDS_MAX, type RedirectNeed } from "@intentic/sandbox-contract/schemas/needs";
import { type PersonOpening, personOpeningOf } from "../../account-routing/person-opening.js";
import { type RouteAnswer, type RouteRequest, routeClientOf } from "../../account-routing/route-client.js";
import { supervisorFor } from "../../agent/subagents/children.js";
import type { Services } from "../../composition.js";
import { turnStandingOf } from "../../conversations/actor/turn-standing.js";
import { projectOfRemote } from "../../account-routing/account-outbox.js";
import { claimedHere } from "../../account-routing/project-claims.js";
import { opt } from "../../opt.js";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A person's message that reached the wrong sandbox, offered on to the one it was meant for (2026-11-25,
// docs/architecture/account-routing.md). The agent names only where it belongs, a sandbox or a project whose claim finds
// it; the words are the daemon's copy of what the person opened a turn with (account-routing/person-opening.ts), and the
// platform finds the target among the sandboxes that person is in. Nothing crosses from here: the person's press, in an
// editor signed in to both, opens a chat over there and sends the words as they would by hand, then answers the need.
// Kept here (a decline) wakes the conversation to get on with it; sent on, nothing is left to do here (`wakesOn`).

export interface RedirectNeedDeps {
    // The words a person last opened a turn of this conversation with.
    readonly opening: (conversationId: string) => PersonOpening | undefined;
    // Whether this conversation's turn may hand work on: not one outside content started, nor one whose role does not delegate.
    readonly mayHandOn: (conversationId: string) => boolean;
    // A repository as the platform keys claims (github.com/owner/repo), from any remote URL of it.
    readonly normalize: (raw: string) => string | undefined;
    // The projects this sandbox claims, when the platform can say.
    readonly claimedHere: () => Promise<{ readonly ok: true; readonly projects: readonly string[] } | { readonly ok: false }>;
    // Where the platform says the target is, for the person.
    readonly locate: (request: RouteRequest) => Promise<RouteAnswer>;
}

const NOTHING = "Nothing was asked";

const refused = (code: string, message: string): Resolved => ({ kind: "refused", code, message: `${NOTHING}: ${message}` });

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const unrouted = (answer: Extract<RouteAnswer, { ok: false }>): Resolved => {
    const named = answer.candidates?.map((candidate) => `${candidate.name} (${candidate.sandboxId})`).join(", ");
    return refused("unrouted", named === undefined ? `${answer.message}.` : `${answer.message}. Name one of them by its id: ${named}.`);
};

const titleOf = (subject: Pick<RedirectNeed, "targetName">): string => `Send this message on to ${subject.targetName}`;

const metFor = (subject: Pick<RedirectNeed, "person" | "targetName">): Met => ({
    result: `${subject.person} sent their message on to ${subject.targetName}: it runs there now, in a conversation of their own.`,
    use: ["Nothing of it is left to do here: do not act on it, and end your turn unless they asked for something else too."],
});

export const redirectNeed = (deps: RedirectNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): RedirectNeed | undefined => (need.subject.kind === "redirect" ? need.subject : undefined);

    // The target and, when it was found by its claim, the project, or why there is none.
    const where = async (ask: Extract<NeedAsk, { kind: "redirect" }>, person: string): Promise<Resolved | { readonly answer: RouteAnswer; readonly project?: string }> => {
        if (ask.target !== undefined) {
            return { answer: await deps.locate({ scope: "read", person, sandbox: ask.target }) };
        }
        const project = deps.normalize(ask.project ?? "");
        if (project === undefined) {
            return refused("invalid_project", `"${ask.project ?? ""}" names no repository. Give it as github.com/owner/repo, or as any remote URL of it.`);
        }
        const here = await deps.claimedHere();
        if (here.ok && here.projects.includes(project)) {
            return refused("here", `this sandbox claims ${project}, so the message belongs here. Carry on with it.`);
        }
        return { answer: await deps.locate({ scope: "report", person, project }), project };
    };

    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "redirect") {
            return { kind: "refused", code: "invalid", message: "Not a redirect ask." };
        }
        if ((ask.target === undefined) === (ask.project === undefined)) {
            return refused("invalid", "name the sandbox the message belongs in, or the project it is about (--project), and not both.");
        }
        if (!deps.mayHandOn(context.conversationId)) {
            return refused("outside", "this turn was started by outside content, or its role does not delegate, so it may not send a person's message elsewhere.");
        }
        const opening = deps.opening(context.conversationId);
        if (opening === undefined) {
            return refused(
                "no_words",
                "no message a person typed is held for this conversation (none since the sandbox last restarted). Say in your reply where it belongs, so they can send it there themselves.",
            );
        }
        if (opening.words.trim() === "") {
            return refused("no_words", "their message was only files, which cannot be sent on. Say in your reply where it belongs.");
        }
        const found = await where(ask, opening.email);
        if (!("answer" in found)) {
            return found;
        }
        if (!found.answer.ok) {
            return unrouted(found.answer);
        }
        const target = found.answer.value;
        const clipped = opening.words.length > REDIRECT_WORDS_MAX;
        const subject: RedirectNeed = {
            kind: "redirect",
            target: target.sandboxId,
            targetName: target.name,
            address: target.address,
            person: opening.email,
            words: clipped ? opening.words.slice(0, REDIRECT_WORDS_MAX) : opening.words,
            ...opt("clipped", clipped ? true : undefined),
            ...opt("attachments", opening.attachments > 0 ? opening.attachments : undefined),
            ...opt("project", found.project),
        };
        return { kind: "raise", subject, title: titleOf(subject) };
    };

    return {
        resolve,
        // Only the person's press sends it, and nothing here can see that it did: met by the answer alone.
        check: async () => undefined,
        mayAnswer: (need, by) => {
            const subject = subjectOf(need);
            if (subject === undefined || (by.email !== undefined && sameEmail(by.email, subject.person))) {
                return undefined;
            }
            return `Only ${subject.person} can answer this: it is their message, sent from their own editor.`;
        },
        // The card's press has already sent the words from the person's editor; this records that it did.
        answer: async (need, answer, by) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A redirect is answered by sending the message on, or by keeping it here." };
            }
            if (by.email === undefined || !sameEmail(by.email, subject.person)) {
                return { refused: `Only ${subject.person} can send their message on.` };
            }
            return { status: "met", ...metFor(subject) };
        },
        nextTurn: () => false,
        wakesOn: "declined",
        key: (subject: NeedSubject) =>
            subject.kind === "redirect" ? `${subject.target}\u0000${createHash("sha256").update(subject.words).digest("hex").slice(0, 16)}` : "",
    };
};

/** The `redirect` need kind, wired to this daemon. */
export const redirectNeedOf = (whole: () => Services): NeedKindHandler =>
    redirectNeed({
        opening: (conversationId) => personOpeningOf(whole().conversations, conversationId),
        // As every routed send asks it (links/route-caller.ts): a turn this daemon planned must be one that may hand work on.
        mayHandOn: (id) => turnStandingOf(whole().conversations, id) === undefined || supervisorFor(whole().conversations, id) !== undefined,
        normalize: projectOfRemote,
        claimedHere: () => claimedHere(whole().config),
        locate: (request) => routeClientOf(whole()).routeTo(request),
    });
