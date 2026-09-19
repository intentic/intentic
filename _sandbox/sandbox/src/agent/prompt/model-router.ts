import { errorMessage } from "@intentic/base/errors";
import { type ModelOffer, type ModelPick, type ModelRoute, type ModelRouteAsk, type ParsedPick, modelPinKey, offerLines, parseModelPick } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { autoOffer } from "../models/auto-offer.js";
import type { RoleAnswer } from "../models/role-answer.js";
import { askRoleModel } from "../models/role-model.js";

// Chooses what a whole conversation runs on from its opening message: a classification over an offered list, not a
// judgement about how the work should go. Runs once per chat and never again, so the cost is one reading amortised
// over every turn that follows, and the user owns the pick from turn two.
//
// The only thing that chooses a model on the user's behalf. It runs before the conversation has, chooses across
// providers, efforts and accounts, and reads live allowances no prompt-only scorer could infer.

// Opening message front-loads the ask; a long message's tail only dilutes the question it opens with.
const MESSAGE_MAX_CHARS = 600;
// A sent message is held back for this long at most; the caller's own wait is longer, so this deadline, not the wire,
// is what ends a slow reading.
const ROUTE_DEADLINE_MS = 5_000;

const excerpt = (text: string): string => {
    const clean = text.trim();
    return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS)}\n… (truncated)`;
};

// Facts the words alone cannot carry, and which move the answer: a message naming twenty files is a different job from
// the same sentence naming none. Stated only when true, so an ordinary chat's prompt stays short.
const chatFacts = (ask: ModelRouteAsk): readonly string[] => {
    const facts = [
        ...(ask.paths.length === 0 ? [] : [`- The message names ${ask.paths.length} file${ask.paths.length === 1 ? `` : `s`}: ${ask.paths.map((path) => `\`${path}\``).join(`, `)}.`]),
        ...(ask.editorContext === true ? [`- It carries a file and selection the user pointed at, so it is about real code in front of them.`] : []),
        ...(ask.planMode === true ? [`- The chat opens in plan mode: it is being asked to think the work through before touching anything.`] : []),
    ];
    return facts.length === 0 ? [] : [``, `Facts about the chat:`, ...facts];
};

export const routerPrompt = (ask: ModelRouteAsk, offer: ModelOffer, now: number): string =>
    [
        `Choose the model a new chat should run on, reading the message it opens with.`,
        ``,
        `This choice is made once and holds for the whole conversation, so weigh what the work is likely to become, not just the first sentence. A question about how something works, a rename, a one-file edit: the cheapest model that will not embarrass itself. Work spanning several files, a design decision, a bug whose cause is unknown, anything asking to think first: the strongest model available. Most chats are somewhere between, and the middle rung is the honest answer for them.`,
        ``,
        `Spend allowance the way somebody would who has to live with the rest of the month: do not put easy work on a scarce account, and do not refuse to use a strong model when there is plenty left. An account whose allowance was never measured is unknown, not empty.`,
        ``,
        ...offerLines(offer, now),
        ...chatFacts(ask),
        ``,
        `Opening message:`,
        excerpt(ask.prompt),
        ``,
        `Reply with exactly these three lines and nothing else:`,
        `model: <one \`provider:model\` from the list above>`,
        `effort: <one of that model's efforts, or omit this line to take its default>`,
        `account: <one account id from that provider's list, or omit this line to leave it to whichever has most headroom>`,
    ].join(`\n`);

// A pick naming a model on the list is a real verdict; anything else is a rung that ignored the list, stepped over as
// unusable so the next one answers rather than the turn running an id no provider has.
export const routeAnswer = (offer: ModelOffer): RoleAnswer<ParsedPick> => ({
    what: `a model from the list`,
    read: (reply) => parseModelPick(reply, offer),
    unusable: ({ pick, token }) =>
        pick !== undefined ? undefined : token === `` ? `named no model at all` : `named "${token}", which is not on the list it was given`,
});

// Names what a pick means in the one line a chat can show. Effort and account are only mentioned when chosen, since an
// omitted one is the turn's own default rather than a decision anybody made.
const pickWords = (pick: ModelPick, label: string): string => {
    const effort = pick.effort === undefined ? `` : ` at ${pick.effort} effort`;
    const account = pick.account === undefined ? `` : ` on ${pick.account}`;
    return `${label}${effort}${account}`;
};

export const routeModel = async (services: Services, ask: ModelRouteAsk, signal?: AbortSignal): Promise<ModelRoute> => {
    const offer = await autoOffer(services);
    if (offer.models.length === 0) {
        return { reason: `Nothing connected can run a turn right now, so this chat keeps the model it had.` };
    }
    // One runnable model is not a choice; spending a reading to confirm the only option is the one case this must skip.
    const only = offer.models.length === 1 ? offer.models[0] : undefined;
    if (only !== undefined) {
        return { pick: { provider: only.provider, model: only.model }, reason: `${only.label} is the only model with allowance left.` };
    }
    const deadline = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
    try {
        const answer = await askRoleModel(services, "model-router", { prompt: routerPrompt(ask, offer, Date.now()), answer: routeAnswer(offer) }, deadline);
        const pick = answer.value.pick;
        const judge = modelPinKey(answer.choice);
        if (pick === undefined) {
            return { reason: `Couldn't choose a model for this chat, so it keeps the one it had.`, judge };
        }
        const label = offer.models.find((model) => model.provider === pick.provider && model.model === pick.model)?.label ?? pick.model;
        return { pick, reason: `Read the opening message as work for ${pickWords(pick, label)}.`, judge };
    } catch (error: unknown) {
        // A spent chain, an unset role, or the deadline: the chat runs on its own pick, with a reason it can show.
        services.logger.warn({ err: error }, "auto model: no answer, the chat keeps the model it had");
        return { reason: `Couldn't choose a model: ${errorMessage(error)}` };
    }
};
