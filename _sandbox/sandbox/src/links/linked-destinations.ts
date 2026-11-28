import type { Capability, LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RouteAnswer, RouteTarget } from "../account-routing/route-client.js";
import type { Pairing } from "../account-routing/require-pairing.js";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";
import type { LinkTarget } from "../sandboxes/link-client.js";
import type { StoredChild } from "./linked-children-store.js";

/* WHERE A HANDED-OVER TASK GOES, AND HOW IT IS REACHED AGAIN (linked-children.ts). Two kinds of far side share one
 * follower: a link card (its address and token), and since 2026-11-24 a sandbox the person this conversation acts for is
 * in, reached as them (account-routing.md, the `task` scope): the platform's pass and that person's pairing secret, on
 * the `/account/task` doors. A link is for unattended work under the taking owner's terms; a person route is the
 * person's own work in a sandbox they are already in (links.md says when each fits). */

export type LinkCard = Extract<Capability, { kind: "link" }>;

export const isLinkCard = (capability: Capability): capability is LinkCard => capability.kind === "link";

export const sandboxNameOf = (card: { readonly id: string; readonly config: LinkConfig }): string => card.config.name ?? card.id;

// The asking side of routing as a person, off the daemon's services (person-routes.ts), injectable for a test.
export interface PersonRoutes {
    // The one person this conversation acts for, or why it acts for no one person.
    readonly personOf: (conversationId: string) => Promise<{ readonly person: string } | { readonly refused: string }>;
    // Where `sandbox` is for `person`, and the pass to show there; `fresh` asks the platform again.
    readonly routeTo: (person: string, sandbox: string, fresh?: boolean) => Promise<RouteAnswer>;
    // The person's pairing secret for the target, or the card that now asks them for it.
    readonly pairing: (conversationId: string, target: RouteTarget, person: string) => Promise<Pairing>;
    readonly secretFor: (sandboxId: string, person: string) => Promise<string | undefined>;
    // Drops a secret the far side said it no longer holds, so the next hand-over asks the person again.
    readonly forget: (sandboxId: string, person: string) => Promise<void>;
}

export interface DestinationDeps {
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly standingOf: (conversationId: string) => TurnStanding | undefined;
    readonly personRoutes?: PersonRoutes | undefined;
}

// What a child's record says about where it went.
export type Filed = Pick<StoredChild, "link" | "url" | "sandbox" | "sandboxId" | "via" | "person">;

// Where a new task goes, or why it goes nowhere: `open` names the need now asking the person for their pairing.
export type Destination = { readonly target: LinkTarget; readonly filed: Filed } | { readonly refused: string; readonly open?: string };

// Reaching a filed task again: the target, gone for good, or not now (a platform that did not answer).
export type Reached = { readonly target: LinkTarget } | { readonly gone: string } | { readonly retry: string };

// The card a task went through: by its name, else by its address, which a rename leaves alone.
const cardFor = async (deps: Pick<DestinationDeps, "capabilities">, link: string, url?: string): Promise<LinkCard | undefined> => {
    const cards = (await deps.capabilities()).filter(isLinkCard);
    return cards.find((card) => card.id === link) ?? (url === undefined ? undefined : cards.find((card) => card.config.url === url));
};

const cardTarget = (card: LinkCard): LinkTarget => ({ id: card.id, config: card.config });

// A person route as the wire calls it, under an id of its own so the backoff and the listing keep it apart from a card.
const personTarget = (route: RouteTarget, secret: string): LinkTarget => ({
    id: `route:${route.sandboxId}`,
    config: { url: route.address, token: "" },
    pass: route.pass,
    secret,
    doors: "account",
});

/** A link card, if this turn may hand work to it. */
export const cardDestination = async (deps: DestinationDeps, conversationId: string, to: string): Promise<Destination> => {
    const card = await cardFor(deps, to);
    if (card === undefined) {
        const names = (await deps.capabilities()).filter(isLinkCard).map((entry) => entry.id);
        return {
            refused:
                names.length === 0
                    ? 'This sandbox is linked to no other sandbox. Connecting one is the owner\'s: `capabilities request link --why "…"`. ' +
                      "A sandbox the person you work for is in takes the task as them instead: delegate with `to` and `as_person`, or `agents delegate --to <sandbox>`."
                    : `No linked sandbox is called "${to}". Linked here: ${names.join(", ")}.`,
        };
    }
    const standing = deps.standingOf(conversationId);
    if (standing !== undefined && !standing.granted.includes(card.id)) {
        return { refused: `This conversation's turn was not given the "${card.id}" link: its role or the people it works for leave it out. Do the work here, or say what you left undone.` };
    }
    return { target: cardTarget(card), filed: { link: card.id, url: card.config.url, sandbox: sandboxNameOf(card), sandboxId: card.config.sandboxId } };
};

// The platform's refusal, said as what to do next.
const routeRefusal = (answer: Extract<RouteAnswer, { ok: false }>, person: string, to: string): string => {
    if (answer.status === 0) {
        return `The platform could not be asked where "${to}" is (${answer.message}). Nothing was handed over; try again shortly.`;
    }
    if (answer.status === 409) {
        return `"${to}" names more than one sandbox ${person} is in: ${answer.message}. Name one by its id.`;
    }
    return `"${to}" is not a sandbox ${person} can hand work to: ${answer.message}.`;
};

/** A sandbox the person this conversation acts for is in, reached as them; the pairing card when they have not allowed it. */
export const personDestination = async (deps: DestinationDeps, conversationId: string, to: string): Promise<Destination> => {
    const routes = deps.personRoutes;
    if (routes === undefined) {
        return { refused: "This sandbox cannot hand work on as a person." };
    }
    const who = await routes.personOf(conversationId);
    if ("refused" in who) {
        return who;
    }
    const answer = await routes.routeTo(who.person, to);
    if (!answer.ok) {
        return { refused: routeRefusal(answer, who.person, to) };
    }
    const pairing = await routes.pairing(conversationId, answer.value, who.person);
    if ("asked" in pairing) {
        return { refused: pairing.asked, open: pairing.needId };
    }
    if ("refused" in pairing) {
        return { refused: pairing.refused };
    }
    const route = answer.value;
    return {
        target: personTarget(route, pairing.secret),
        filed: { link: `route:${route.sandboxId}`, url: route.address, sandbox: route.name, sandboxId: route.sandboxId, via: "person", person: who.person },
    };
};

// A filed person route reached again: the platform asked (from its cache unless `fresh`), the secret read again.
const personReached = async (deps: DestinationDeps, stored: StoredChild & { readonly person: string }, fresh: boolean): Promise<Reached> => {
    const routes = deps.personRoutes;
    if (routes === undefined) {
        return { gone: "this sandbox no longer routes as a person" };
    }
    const sandbox = stored.sandboxId ?? stored.sandbox;
    const answer = await routes.routeTo(stored.person, sandbox, fresh);
    if (!answer.ok) {
        const why = `the platform did not say where "${stored.sandbox}" is: ${answer.message}`;
        return answer.status === 0 || answer.status >= 500 ? { retry: why } : { gone: why };
    }
    const secret = await routes.secretFor(answer.value.sandboxId, stored.person);
    if (secret === undefined) {
        return { gone: `this sandbox no longer holds ${stored.person}'s pairing with "${stored.sandbox}"` };
    }
    return { target: personTarget(answer.value, secret) };
};

/** How a filed task is reached now: its card, or the person route it went over. */
export const targetFor = async (deps: DestinationDeps, stored: StoredChild, fresh = false): Promise<Reached> => {
    if (stored.via === "person" && stored.person !== undefined) {
        return personReached(deps, { ...stored, person: stored.person }, fresh);
    }
    const card = await cardFor(deps, stored.link, stored.url);
    return card === undefined ? { gone: `The link card "${stored.link}" was removed here` } : { target: cardTarget(card) };
};

/** Words for a far side that could not be reached, for an action the agent asked for. */
export const unreachedWords = (reached: Reached): string => ("gone" in reached ? reached.gone : "retry" in reached ? reached.retry : "it was reached");
