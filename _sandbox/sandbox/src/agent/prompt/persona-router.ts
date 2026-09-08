import { errorMessage } from "@intentic/base/errors";
import type { Persona, PersonaRoute, PersonaRouteAsk } from "@intentic/sandbox-contract";
import type { RoleAnswer } from "../models/role-answer.js";
import { askRoleModel } from "../models/role-model.js";
import type { Services } from "../../composition.js";
import { BULLET, FENCE } from "@intentic/sandbox-contract";

// Routes a new chat to one persona card by classification (pick one of N), not composition; `none` is a real, safe
// default, never a failure. Attended chats only — an unattended wake must not gain a persona's accounts from a model's
// guess. A folder match is tried before asking any model.

// Opening message front-loads the ask; a long message's tail only dilutes the question it opens with.
const MESSAGE_MAX_CHARS = 600;
// Composer's chip waits on this; past it, the chat opens unrouted as if nothing had been asked.
const ROUTE_DEADLINE_MS = 6_000;
const NONE = "none";

const excerpt = (text: string): string => {
    const clean = text.trim();
    return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS)}\n… (truncated)`;
};

// One line per card: its own brief, then what it carries, where it starts, and which sites it speaks through — words a
// message could echo. Account ids are excluded; only their sites are (`reddit`, not `reddit-work`).
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

// Wrapper words a model reaches for anyway: a fence, a label, a bullet, quotes, a trailing period.
const LABEL = /^(?:persona|id|answer)\s*:\s*/iu;

export interface RouteVerdict {
    // Card named, or undefined when the reply was `none`.
    readonly persona: string | undefined;
    // Reply's literal answer, for the refusal sentence when it named nothing on the list.
    readonly token: string;
}

// A listed id or `none` is a real verdict; anything else is a rung that ignored the list and is stepped over as
// unusable. Matched case-insensitively; the list itself is the authority on spelling.
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

// Site an account id belongs to; only browser accounts have one, everything else is named by its id.
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

// Cards whose folder the chat was opened in: those that start there or carry it as a repository.
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
        // A spent chain, no account, or the deadline: the chat opens unrouted, with a reason the chip can show.
        services.logger.warn({ err: error }, "persona router: no answer, the chat stays open");
        return { reason: `Could not route: ${errorMessage(error)}` };
    }
};
