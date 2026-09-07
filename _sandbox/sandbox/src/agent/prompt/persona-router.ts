import { errorMessage } from "@intentic/base/errors";
import type { Persona, PersonaRoute, PersonaRouteAsk } from "@intentic/sandbox-contract";
import type { RoleAnswer } from "../models/role-answer.js";
import { askRoleModel } from "../models/role-model.js";
import type { Services } from "../../composition.js";
import { BULLET, FENCE } from "@intentic/sandbox-contract";

/* WHICH PERSONA A NEW CHAT BELONGS TO, decided once, from its first message, before the first turn.
 *
 * THIS IS THE ONE PER-CHAT DECISION THE CONTEXT LAYER MAKES, and it is deliberately a classification rather
 * than a composition. A model asked to assemble a context per session (pick the repositories, the skills, the
 * tools) either does it cheaply and badly, so the session walks outside its context anyway, or does it well at
 * the price of a second strong run and a hand-off of everything it decided. A model asked to pick ONE card off
 * the owner's own short list, each card a line the owner wrote (schemas/personas.ts `brief`), is cheap by
 * construction, is the job a small model does reliably, and hands the session a context that was written once,
 * tested by use, and identical for every session that wears it. The card is the static context; this file only
 * says which one.
 *
 * THE ANSWER IS ONE ID OR `none`, and `none` is a real answer rather than a failure: a chat with no persona
 * reaches everything, so routing nowhere costs nothing, while routing onto the wrong card hides the repositories
 * the work needs. The prompt says so, the reply contract enforces it, and every road out of here that is not a
 * confident id (no cards, no model, a rung that named a card that does not exist, a deadline) is `none` with a
 * reason the chip can show. Nothing here ever throws to the composer.
 *
 * ATTENDED CHATS ONLY. The route is asked by the composer under settings.personaRouting; nothing in the daemon
 * asks it for a wake, because a persona GRANTS an unattended turn accounts, and the rule that a wake reaches
 * only what its own form named (personas/personas.ts turnPersona) must not be undone by a model's guess.
 *
 * IT LIVES HERE, beside the other helper asks (title-namer.ts), rather than under personas/: it spends the
 * one-shot seam, which is this subsystem's, and personas/ must not reach into agent/ for a value while agent/
 * already reads personas/ for the turn's card. The persona routes take it as a parameter (router.ts wires it),
 * which is the type-only port that keeps the two subsystems one-way.
 *
 * ONE DETERMINISTIC SHORTCUT, taken before any model is asked: a chat opened in a folder that exactly one card
 * starts in or carries is that card's chat, no reading required. Several cards or none, and the words decide. */

// Retrieval's rule (agent/turn-context.ts): an opening message front-loads the ask, and a long one is a spec
// whose tail dilutes the question it opens with.
const MESSAGE_MAX_CHARS = 600;
// The composer's chip waits on this; a rung that has not answered in this long is a rung that is not going to,
// and the chat opens as it would have without routing. The walk itself is bounded per rung by the helper seam.
const ROUTE_DEADLINE_MS = 6_000;
const NONE = "none";

const excerpt = (text: string): string => {
    const clean = text.trim();
    return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS)}\n… (truncated)`;
};

/* ONE CARD, ON ONE LINE, everything about it a reader could match a message against: its own sentence first,
 * then the facts (what it carries, where it starts, which sites it speaks through). Account IDS are not on the
 * line, only their sites: `reddit-work` says nothing a message can echo, `reddit` does. */
export const candidateLine = (card: Persona, siteOf: (capability: string) => string | undefined): string => {
    const facts = [
        ...(card.brief === undefined ? [] : [card.brief.trim().replace(/\.$/u, "")]),
        ...(card.context === undefined
            ? []
            : [`Carries: ${card.context.repos.length === 0 ? "the workspace repository only" : card.context.repos.join(", ")}`]),
        ...(card.workspace?.startIn === undefined ? [] : [`Starts in: ${card.workspace.startIn}`]),
        ...(card.capabilities.length === 0 ? [] : [`Speaks through: ${[...new Set(card.capabilities.map((id) => siteOf(id) ?? id))].join(", ")}`]),
    ];
    const name = card.label === undefined || card.label === card.id ? card.id : `${card.id} (${card.label})`;
    return `- ${name}${facts.length === 0 ? "" : `: ${facts.join(". ")}.`}`;
};

export const routerPrompt = (ask: PersonaRouteAsk, lines: readonly string[]): string =>
    [
        `Which of these personas should handle a new chat? Reply with exactly one persona id from the list, or \`${NONE}\` when no persona fits.`,
        ``,
        `A persona is a working posture: what it is for, the repositories its sessions carry, the folder it starts in, the sites it speaks through. Pick the one whose line the message belongs to.`,
        `\`${NONE}\` is the right answer when the message is general or fits no line clearly better than the rest: a chat with no persona reaches everything, so \`${NONE}\` costs nothing, while a wrong persona hides the repositories the work needs.`,
        ``,
        `Personas:`,
        ...lines,
        ...(ask.folder === undefined && ask.paths.length === 0
            ? []
            : [
                  ``,
                  `Facts about the chat:`,
                  ...(ask.folder === undefined ? [] : [`- Opened in the folder \`${ask.folder}\`.`]),
                  ...(ask.paths.length === 0 ? [] : [`- The message names ${ask.paths.map((path) => `\`${path}\``).join(", ")}.`]),
              ]),
        ``,
        `Opening message:`,
        excerpt(ask.prompt),
        ``,
        `Reply with the id or \`${NONE}\` only: no quotes, no explanation.`,
    ].join(`\n`);

// Wrappers a model reaches for even when told not to: a fence, a label, a bullet, quotes, a trailing period.
const LABEL = /^(?:persona|id|answer)\s*:\s*/iu;

export interface RouteVerdict {
    // The card named, or undefined for `none`.
    readonly persona: string | undefined;
    // What the reply actually said, for the sentence that refuses one that named nothing on the list.
    readonly token: string;
}

/* THE REPLY, AS A VERDICT. A card id on the list is that card; `none` is no card; anything else is a rung that
 * did not follow the list (a hallucinated id, a paragraph, a question back) and is stepped over for the next
 * rung (role-answer.ts UnusableAnswerError), because a card the workspace does not have is not a softer kind of
 * answer, it is a model that did not read the list. Ids are matched case-insensitively: the list is the
 * authority on spelling, and a rung that lowercased one still named it. */
export const routeAnswer = (ids: ReadonlySet<string>): RoleAnswer<RouteVerdict> => {
    const byLower = new Map([...ids].map((id) => [id.toLowerCase(), id]));
    return {
        what: `a persona id or ${NONE}`,
        read: (reply) => {
            const first =
                reply
                    .trim()
                    .replace(FENCE, ``)
                    .split(`\n`)
                    .map((line) => line.trim())
                    .find((line) => line !== ``) ?? ``;
            const bare = first
                .replace(BULLET, ``)
                .replace(LABEL, ``)
                .replace(/[.`'"]+$/u, ``)
                .replace(/^[`'"]+/u, ``)
                .trim();
            const token = bare.split(/\s+/u)[0] ?? ``;
            return { persona: byLower.get(token.toLowerCase()), token };
        },
        unusable: ({ persona, token }) =>
            persona !== undefined || token.toLowerCase() === NONE ? undefined : `named "${token}", which is no persona here`,
    };
};

// The site an account id belongs to, for the candidate line. Only browser accounts have one; anything else is
// named by its id.
const siteLookup = (
    capabilities: readonly { readonly id: string; readonly kind: string; readonly config: unknown }[],
): ((id: string) => string | undefined) => {
    const sites = new Map(
        capabilities.flatMap((capability) => {
            const platform = capability.kind === "browser" ? (capability.config as { readonly platform?: string }).platform : undefined;
            return platform === undefined ? [] : [[capability.id, platform] as const];
        }),
    );
    return (id) => sites.get(id);
};

// The cards whose folder the chat was opened in: the ones that start there, or carry it as a repository.
const homedIn = (cards: readonly Persona[], folder: string): Persona[] =>
    cards.filter((card) => card.workspace?.startIn === folder || card.context?.repos.includes(folder) === true);

const nameOf = (card: Persona): string => card.label ?? card.id;

export const routePersona = async (services: Services, ask: PersonaRouteAsk, signal?: AbortSignal): Promise<PersonaRoute> => {
    const cards = await services.personas.list();
    if (cards.length === 0) {
        return { reason: `No personas to route onto.` };
    }
    if (ask.folder !== undefined) {
        const homed = homedIn(cards, ask.folder);
        if (homed.length === 1 && homed[0] !== undefined) {
            return { persona: homed[0].id, reason: `Opened in ${ask.folder}, which ${nameOf(homed[0])} works in.` };
        }
    }
    const siteOf = siteLookup(await services.capabilities.list());
    const lines = cards.map((card) => candidateLine(card, siteOf));
    const deadline = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
    try {
        const answer = await askRoleModel(
            services,
            "persona-router",
            { prompt: routerPrompt(ask, lines), answer: routeAnswer(new Set(cards.map((card) => card.id))) },
            deadline,
        );
        const card = cards.find((entry) => entry.id === answer.value.persona);
        return card === undefined
            ? { reason: `No persona fits this message.` }
            : { persona: card.id, reason: `The message reads like ${nameOf(card)}'s work.` };
    } catch (error: unknown) {
        // A spent chain, no account, the deadline: the chat opens as it would have without routing, and the
        // chip says why nothing was picked rather than showing nothing at all.
        services.logger.warn({ err: error }, "persona router: no answer, the chat stays open");
        return { reason: `Could not route: ${errorMessage(error)}` };
    }
};
