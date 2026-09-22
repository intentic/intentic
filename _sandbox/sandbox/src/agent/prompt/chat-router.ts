import { errorMessage } from "@intentic/base/errors";
import {
    BULLET,
    type ChatRoute,
    type ChatRouteAsk,
    FENCE,
    type ModelOffer,
    type ModelPick,
    type ParsedPick,
    type Persona,
    modelPinKey,
    offerLines,
    parseModelPick,
    replyFields,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { reachablePersonas } from "../../personas/persona-reach.js";
import { autoOffer } from "../models/auto-offer.js";
import type { RoleAnswer } from "../models/role-answer.js";
import { askRoleModel } from "../models/role-model.js";

// What a new chat opens on, read once from the message it opens with: which persona handles it, and which model,
// effort and account it runs on. Two questions, one classification each over a list this sandbox supplies, and ONE
// reading for both — a chat wanting both answers pays for one call, not two, and a chat wanting one is asked only
// that one (`ask.model` / `ask.persona`, the two settings as this chat sees them).
//
// It runs once per chat and never again, so the cost is amortised over every turn that follows, and the user owns both
// answers from turn two. The only place either is chosen on the user's behalf: it runs before the conversation has,
// chooses across providers, efforts and accounts, and reads live allowances no prompt-only scorer could infer.
//
// Unattended wakes are never routed: a wake names its own persona, and a model's guess must not hand it accounts
// nobody named for it.

// Opening message front-loads the ask; a long message's tail only dilutes the question it opens with.
const MESSAGE_MAX_CHARS = 600;
// A sent message is held back for this long at most; the caller's own wait is longer, so this deadline, not the wire,
// is what ends a slow reading.
const ROUTE_DEADLINE_MS = 5_000;
const NONE = "none";

type PersonaVerdict = NonNullable<ChatRoute["persona"]>;
type ModelVerdict = NonNullable<ChatRoute["model"]>;

// What is left for a model to answer once each half has answered what it can on its own. A half that settled itself —
// the only runnable model, a folder naming one persona — is absent here, so it is never put to the judge, and a half
// the chat never asked about is absent for the same reason.
export interface Asked {
    readonly offer?: ModelOffer;
    readonly personas?: readonly Persona[];
}

const excerpt = (text: string): string => {
    const clean = text.trim();
    return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS)}\n… (truncated)`;
};

// One line per persona: its own brief, then what it carries, where it starts, and which sites it speaks through — words a
// message could echo. Account ids are excluded; only their sites are (`reddit`, not `reddit-work`).
export const candidateLine = (persona: Persona, siteOf: (capability: string) => string | undefined): string => {
    const facts = [
        ...(persona.brief === undefined ? [] : [persona.brief.trim().replace(/\.$/u, "")]),
        ...(persona.context === undefined
            ? []
            : [`Carries: ${persona.context.repos.length === 0 ? "the workspace repository only" : persona.context.repos.join(", ")}`]),
        ...(persona.workspace?.startIn === undefined ? [] : [`Starts in: ${persona.workspace.startIn}`]),
        ...(persona.capabilities.length === 0 ? [] : [`Speaks through: ${[...new Set(persona.capabilities.map((id) => siteOf(id) ?? id))].join(", ")}`]),
    ];
    const name = persona.label === undefined || persona.label === persona.id ? persona.id : `${persona.id} (${persona.label})`;
    return `- ${name}${facts.length === 0 ? "" : `: ${facts.join(". ")}.`}`;
};

// What a persona is, and why `none` costs nothing. Only shown to a reading that is choosing one.
const personaAdvice = (personas: readonly Persona[] | undefined, siteOf: (capability: string) => string | undefined): readonly string[] =>
    personas === undefined
        ? []
        : [
              ``,
              `A persona is a working posture: what it is for, the repositories its sessions carry, the folder it starts in, the sites it speaks through. Pick the one whose line the message belongs to.`,
              `\`${NONE}\` is the right answer when the message is general or fits no line clearly better than the rest: a chat with no persona reaches everything, so \`${NONE}\` costs nothing, while a wrong persona hides the repositories the work needs.`,
              ``,
              `Personas:`,
              ...personas.map((persona) => candidateLine(persona, siteOf)),
          ];

// The owner's own standing preferences, from settings (`autoModelGuidance`). Their text, not a visitor's, so it is
// instruction rather than data — but it sits BEFORE the offer and the reply contract, so the format lines are the last
// thing read and no wording of theirs can quietly cost them a usable answer. It cannot widen the choice either: a model
// it names that is not on the list below is read back as no pick at all (parseModelPick).
const ownerGuidance = (guidance: string): readonly string[] => {
    const text = guidance.trim();
    return text === ``
        ? []
        : [``, `The owner of this sandbox has written standing preferences for the model choice. Where they disagree with the paragraphs above, follow the owner:`, text];
};

// How to weigh the model choice, then what may be chosen from. Only shown to a reading that is choosing one.
const modelAdvice = (offer: ModelOffer | undefined, now: number, guidance: string): readonly string[] =>
    offer === undefined
        ? []
        : [
              ``,
              `The model choice is made once and holds for the whole conversation, so weigh what the work is likely to become, not just the first sentence. A question about how something works, a rename, a one-file edit: the cheapest model that will not embarrass itself. Work spanning several files, a design decision, a bug whose cause is unknown, anything asking to think first: the strongest model available. Most chats are somewhere between, and the middle rung is the honest answer for them.`,
              ``,
              `Spend allowance the way somebody would who has to live with the rest of the month: do not put easy work on a scarce account, and do not refuse to use a strong model when there is plenty left. An account whose allowance was never measured is unknown, not empty.`,
              ...ownerGuidance(guidance),
              ``,
              ...offerLines(offer, now),
          ];

// Facts the words alone cannot carry, and which move the answer: a message naming twenty files is a different job from
// the same sentence naming none, and the folder a chat was opened in is ground a persona works on. Each fact is shown
// only to a reading that can use it, and only when true, so an ordinary chat's prompt stays short.
const chatFacts = (ask: ChatRouteAsk, asked: Asked): readonly string[] => {
    const forPersona = asked.personas !== undefined;
    const forModel = asked.offer !== undefined;
    const files = ask.paths.map((path: string) => `\`${path}\``).join(`, `);
    const facts = [
        ...(forPersona && ask.folder !== undefined ? [`- Opened in the folder \`${ask.folder}\`.`] : []),
        ...(ask.paths.length === 0 ? [] : [`- The message names ${ask.paths.length} file${ask.paths.length === 1 ? `` : `s`}: ${files}.`]),
        ...(forModel && ask.editorContext === true ? [`- It carries a file and selection the user pointed at, so it is about real code in front of them.`] : []),
        ...(forModel && ask.planMode === true ? [`- The chat opens in plan mode: it is being asked to think the work through before touching anything.`] : []),
    ];
    return facts.length === 0 ? [] : [``, `Facts about the chat:`, ...facts];
};

// The opening sentence names exactly what is being asked for, so a reading of one half never reads as a reading of two.
const headline = (asked: Asked): string => {
    if (asked.personas === undefined) {
        return `Choose the model a new chat should run on, reading the message it opens with.`;
    }
    return asked.offer === undefined
        ? `Choose which persona should handle a new chat, reading the message it opens with.`
        : `Choose what a new chat opens on, reading the message it opens with: which persona should handle it, and which model it should run on.`;
};

// The keyed lines the reply must carry, one per thing being chosen, and nothing for a half that isn't.
const replyContract = (asked: Asked): readonly string[] => {
    const lines = [
        ...(asked.personas === undefined ? [] : [`persona: <one persona id from the list above, or \`${NONE}\`>`]),
        ...(asked.offer === undefined
            ? []
            : [
                  `model: <one \`provider:model\` from the list above>`,
                  `effort: <one of that model's efforts, or omit this line to take its default>`,
                  `account: <one account id from that provider's list, or omit this line to leave it to whichever has most headroom>`,
              ]),
    ];
    return [``, `Reply with exactly ${lines.length === 1 ? `this line` : `these ${lines.length} lines`} and nothing else:`, ...lines];
};

export const routerPrompt = (
    ask: ChatRouteAsk,
    asked: Asked,
    now: number,
    guidance = ``,
    siteOf: (capability: string) => string | undefined = () => undefined,
): string =>
    [
        headline(asked),
        ...personaAdvice(asked.personas, siteOf),
        ...modelAdvice(asked.offer, now, guidance),
        ...chatFacts(ask, asked),
        ``,
        `Opening message:`,
        excerpt(ask.prompt),
        ...replyContract(asked),
    ].join(`\n`);

// What one reply was read as. Each half is undefined when it wasn't asked for; inside the persona half, an undefined
// `id` is a deliberate `none` rather than a failure.
export interface RouteVerdict {
    readonly model?: ParsedPick;
    readonly persona?: { readonly id: string | undefined; readonly token: string };
}

// Wrapper words a model reaches for anyway around a bare id: a fence, a label, a bullet, quotes, a trailing period.
const LABEL = /^(?:persona|id|answer)\s*:\s*/iu;

const firstWord = (reply: string): string => {
    const first =
        reply
            .trim()
            .replace(FENCE, ``)
            .split(`\n`)
            .map((line) => line.trim())
            .find((line) => line !== ``) ?? ``;
    return (
        first
            .replace(BULLET, ``)
            .replace(LABEL, ``)
            .replace(/[.`'"]+$/u, ``)
            .replace(/^[`'"]+/u, ``)
            .trim()
            .split(/\s+/u)[0] ?? ``
    );
};

// The persona the reply names: its own keyed line, else the bare word a one-question reply is allowed to be. A keyed
// reply that answered the model and skipped this line reads as `none` — the safe answer — rather than as a rung that
// ignored the list it was given.
const personaToken = (reply: string): string => {
    const fields = replyFields(reply, [`persona`, `id`, `answer`, `model`, `effort`, `account`]);
    const named = fields.get(`persona`) ?? fields.get(`id`) ?? fields.get(`answer`);
    if (named !== undefined) {
        return named.split(/\s+/u)[0] ?? ``;
    }
    return fields.size === 0 ? firstWord(reply) : NONE;
};

// Why this reply is unusable, or undefined when it answered what it was asked. A model not on the list and a persona
// that is no persona here are both a rung ignoring its list, stepped over so the next one answers rather than the chat
// running an id no provider has or acting as somebody nobody made.
const wrongAnswers = (verdict: RouteVerdict): readonly string[] => {
    const { model, persona } = verdict;
    const badPersona = persona !== undefined && persona.id === undefined && persona.token.toLowerCase() !== NONE;
    const badModel = model !== undefined && model.pick === undefined;
    return [
        ...(badPersona ? [`named "${persona.token}", which is no persona here`] : []),
        ...(badModel ? [model.token === `` ? `named no model at all` : `named "${model.token}", which is not on the list it was given`] : []),
    ];
};

// Matched case-insensitively; the lists themselves are the authority on spelling.
export const routeAnswer = (asked: Asked): RoleAnswer<RouteVerdict> => {
    const offer = asked.offer;
    const personas = asked.personas;
    const byLower = new Map((personas ?? []).map((persona) => [persona.id.toLowerCase(), persona.id]));
    const wants = [...(personas === undefined ? [] : [`a persona id or ${NONE}`]), ...(offer === undefined ? [] : [`a model from the list`])];
    return {
        what: wants.join(` and `),
        read: (reply) => {
            const token = personas === undefined ? undefined : personaToken(reply);
            return {
                ...(offer === undefined ? {} : { model: parseModelPick(reply, offer) }),
                ...(token === undefined ? {} : { persona: { id: byLower.get(token.toLowerCase()), token } }),
            };
        },
        unusable: (verdict) => {
            const wrong = wrongAnswers(verdict);
            return wrong.length === 0 ? undefined : wrong.join(`; `);
        },
    };
};

// Names what a pick means in the one clause a chat can show. Effort and account are only mentioned when chosen, since
// an omitted one is the turn's own default rather than a decision anybody made.
const pickWords = (pick: ModelPick, label: string): string => {
    const effort = pick.effort === undefined ? `` : ` at ${pick.effort} effort`;
    const account = pick.account === undefined ? `` : ` on ${pick.account}`;
    return `${label}${effort}${account}`;
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

// Personas whose folder the chat was opened in: those that start there or carry it as a repository.
const homedIn = (personas: readonly Persona[], folder: string): readonly Persona[] =>
    personas.filter((persona) => persona.workspace?.startIn === folder || persona.context?.repos.includes(folder) === true);

const nameOf = (persona: Persona): string => persona.label ?? persona.id;

// One half's state before any model is asked: the verdict it reached on its own, or the list it needs a reading for.
interface Half<T, V> {
    readonly settled?: V;
    readonly ask?: T;
}

// One runnable model is not a choice; spending a reading to confirm the only option is the one case this must skip.
const modelHalf = (offer: ModelOffer | undefined): Half<ModelOffer, ModelVerdict> => {
    if (offer === undefined || offer.models.length === 0) {
        return { settled: { reason: `Nothing connected can run a turn right now, so this chat keeps the model it had.` } };
    }
    const only = offer.models.length === 1 ? offer.models[0] : undefined;
    return only === undefined
        ? { ask: offer }
        : { settled: { pick: { provider: only.provider, model: only.model }, reason: `${only.label} is the only model with allowance left.` } };
};

// The one deterministic shortcut, taken before any model is asked: a chat opened in a folder exactly one persona works
// in is that persona's chat.
const personaHalf = (personas: readonly Persona[], folder: string | undefined): Half<readonly Persona[], PersonaVerdict> => {
    if (personas.length === 0) {
        return { settled: { reason: `No personas to route onto.` } };
    }
    const homed = folder === undefined ? [] : homedIn(personas, folder);
    const home = homed.length === 1 ? homed[0] : undefined;
    return home === undefined ? { ask: personas } : { settled: { id: home.id, reason: `Opened in ${folder}, which ${nameOf(home)} works in.` } };
};

const personaVerdict = (named: string | undefined, personas: readonly Persona[]): PersonaVerdict => {
    const persona = personas.find((entry) => entry.id === named);
    return persona === undefined ? { reason: `No persona fits this message.` } : { id: persona.id, reason: `The message reads like ${nameOf(persona)}'s work.` };
};

const modelVerdict = (pick: ModelPick | undefined, offer: ModelOffer): ModelVerdict => {
    if (pick === undefined) {
        return { reason: `Couldn't choose a model for this chat, so it keeps the one it had.` };
    }
    const label = offer.models.find((model) => model.provider === pick.provider && model.model === pick.model)?.label ?? pick.model;
    return { pick, reason: `Read the opening message as work for ${pickWords(pick, label)}.` };
};

// The reply, as the two verdicts a chat can show. Only halves that were asked for are answered.
const verdicts = (verdict: RouteVerdict, asked: Asked): Partial<Pick<ChatRoute, "persona" | "model">> => ({
    ...(asked.personas === undefined ? {} : { persona: personaVerdict(verdict.persona?.id, asked.personas) }),
    ...(asked.offer === undefined ? {} : { model: modelVerdict(verdict.model?.pick, asked.offer) }),
});

// A spent chain, an unset role, or the deadline: every half that was being read says why it has no answer. Whatever
// settled itself without a model still stands, and is merged over this by the caller.
const unread = (asked: Asked, why: string): Partial<Pick<ChatRoute, "persona" | "model">> => ({
    ...(asked.personas === undefined ? {} : { persona: { reason: `Couldn't read which persona this chat belongs to: ${why}` } }),
    ...(asked.offer === undefined ? {} : { model: { reason: `Couldn't choose a model: ${why}` } }),
});

// Each half's own answer and what it still owes a model, from the lists this ask paid to have read.
const halves = (
    ask: ChatRouteAsk,
    offer: ModelOffer | undefined,
    personas: readonly Persona[],
): { readonly asked: Asked; readonly settled: Partial<Pick<ChatRoute, "persona" | "model">> } => {
    const model = ask.model ? modelHalf(offer) : {};
    const persona = ask.persona ? personaHalf(personas, ask.folder) : {};
    return {
        asked: { ...(model.ask === undefined ? {} : { offer: model.ask }), ...(persona.ask === undefined ? {} : { personas: persona.ask }) },
        settled: { ...(persona.settled === undefined ? {} : { persona: persona.settled }), ...(model.settled === undefined ? {} : { model: model.settled }) },
    };
};

// `held` is the asker's areas, undefined for an unfenced one: the persona half picks only from personas that person may
// actually wear, since routing onto one they cannot use would open the chat on a persona every message is refused by.
export const routeChat = async (services: Services, ask: ChatRouteAsk, held: readonly string[] | undefined, signal?: AbortSignal): Promise<ChatRoute> => {
    // Read together, and only what this ask is paying for: an offer costs live allowance readings, which a chat that
    // only wants a persona must not be charged for.
    const [offer, personas, settings] = await Promise.all([
        ask.model ? autoOffer(services) : undefined,
        ask.persona ? reachablePersonas(services, held) : [],
        services.sandboxSettings.get(),
    ]);
    // What each half answered on its own; a reading, if one is still owed, is merged over it below.
    const { asked, settled } = halves(ask, offer, personas);
    if (asked.offer === undefined && asked.personas === undefined) {
        return settled;
    }
    const siteOf = asked.personas === undefined ? undefined : siteLookup(await services.capabilities.list());
    const deadline = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
    try {
        const answer = await askRoleModel(
            services,
            "model-router",
            { prompt: routerPrompt(ask, asked, Date.now(), settings.autoModelGuidance, siteOf), answer: routeAnswer(asked) },
            deadline,
        );
        // Named whether or not anything was chosen: the reading was paid for either way, and the chat says so.
        return { ...settled, ...verdicts(answer.value, asked), judge: modelPinKey(answer.choice) };
    } catch (error: unknown) {
        services.logger.warn({ err: error }, "chat router: no answer, the chat keeps what it had");
        return { ...settled, ...unread(asked, errorMessage(error)) };
    }
};
