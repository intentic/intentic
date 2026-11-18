import { errorMessage } from "@intentic/base/errors";
import { BULLET, FENCE } from "@intentic/sandbox-contract/text/model-answer";
import type { ChatRoute, ChatRouteAsk, ModelPick } from "@intentic/sandbox-contract/schemas/chat-route";
import { humanizeModelId } from "@intentic/sandbox-contract/models/model-label";
import { type ModelOffer, offerLines, type ParsedPick, parseModelPick, replyFields } from "@intentic/sandbox-contract/models/model-offer";
import { modelPinKey } from "@intentic/sandbox-contract/models/model-pins";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { Services } from "../../composition.js";
import { reachableRoles } from "../../roles/role-reach.js";
import { autoOffer } from "../models/auto-offer.js";
import type { RoleAnswer } from "../../engines/role-answer.js";
import { askRoleModel, roleModelIsSet } from "../models/role-model.js";
import { AgentDomainRefusedError, withAgentExecution } from "../../workload/agent-execution.js";
import { RoleModelUnsetError } from "../../seams/role-model-unset.js";

// What a new chat opens on, read once from the message it opens with: which role handles it, and which model,
// effort and account it runs on. Two questions, one classification each over a list this sandbox supplies, and ONE
// reading for both — a chat wanting both answers pays for one call, not two, and a chat wanting one is asked only
// that one (`ask.model` / `ask.role`, the two settings as this chat sees them).
//
// It runs once per chat and never again, so the cost is amortised over every turn that follows, and the user owns both
// answers from turn two. The only place either is chosen on the user's behalf: it runs before the conversation has,
// chooses across providers, efforts and accounts, and reads live allowances no prompt-only scorer could infer.
//
// Unattended wakes are never routed: a wake names its own role, and a model's guess must not hand it accounts
// nobody named for it.

// Opening message front-loads the ask; a long message's tail only dilutes the question it opens with.
const MESSAGE_MAX_CHARS = 600;
// A sent message is held back for this long at most; the caller's own wait is longer, so this deadline, not the wire,
// is what ends a slow reading.
const ROUTE_DEADLINE_MS = 5_000;
const NONE = "none";

type RoleVerdict = NonNullable<ChatRoute["role"]>;
type ModelVerdict = NonNullable<ChatRoute["model"]>;

// What is left for a model to answer once each half has answered what it can on its own. A half that settled itself —
// the only runnable model, a folder naming one role — is absent here, so it is never put to the judge, and a half
// the chat never asked about is absent for the same reason.
export interface Asked {
    readonly offer?: ModelOffer;
    readonly roles?: readonly Role[];
}

const excerpt = (text: string): string => {
    const clean = text.trim();
    return clean.length <= MESSAGE_MAX_CHARS ? clean : `${clean.slice(0, MESSAGE_MAX_CHARS)}\n… (truncated)`;
};

// One line per role: its own brief, then what it carries, where it starts, and which sites it speaks through — words a
// message could echo. Account ids are excluded; only their sites are (`reddit`, not `reddit-work`).
export const candidateLine = (role: Role, siteOf: (capability: string) => string | undefined): string => {
    const facts = [
        ...(role.brief === undefined ? [] : [role.brief.trim().replace(/\.$/u, "")]),
        ...(role.context === undefined
            ? []
            : [`Carries: ${role.context.repos.length === 0 ? "the workspace repository only" : role.context.repos.join(", ")}`]),
        ...(role.workspace?.startIn === undefined ? [] : [`Starts in: ${role.workspace.startIn}`]),
        ...(role.capabilities.length === 0 ? [] : [`Speaks through: ${[...new Set(role.capabilities.map((id) => siteOf(id) ?? id))].join(", ")}`]),
    ];
    const name = role.label === undefined || role.label === role.id ? role.id : `${role.id} (${role.label})`;
    return `- ${name}${facts.length === 0 ? "" : `: ${facts.join(". ")}.`}`;
};

// What a role is, and why `none` costs nothing. Only shown to a reading that is choosing one.
const roleAdvice = (roles: readonly Role[] | undefined, siteOf: (capability: string) => string | undefined): readonly string[] =>
    roles === undefined
        ? []
        : [
              ``,
              `A role is a working posture: what it is for, the repositories its sessions carry, the folder it starts in, the sites it speaks through. Pick the one whose line the message belongs to.`,
              `\`${NONE}\` is the right answer when the message is general or fits no line clearly better than the rest: a chat with no role reaches everything, so \`${NONE}\` costs nothing, while a wrong role hides the repositories the work needs.`,
              ``,
              `Roles:`,
              ...roles.map((role) => candidateLine(role, siteOf)),
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
// the same sentence naming none, and the folder a chat was opened in is ground a role works on. Each fact is shown
// only to a reading that can use it, and only when true, so an ordinary chat's prompt stays short.
const chatFacts = (ask: ChatRouteAsk, asked: Asked): readonly string[] => {
    const forRole = asked.roles !== undefined;
    const forModel = asked.offer !== undefined;
    const files = ask.paths.map((path: string) => `\`${path}\``).join(`, `);
    const facts = [
        ...(forRole && ask.folder !== undefined ? [`- Opened in the folder \`${ask.folder}\`.`] : []),
        ...(ask.paths.length === 0 ? [] : [`- The message names ${ask.paths.length} file${ask.paths.length === 1 ? `` : `s`}: ${files}.`]),
        ...(forModel && ask.editorContext === true ? [`- It carries a file and selection the user pointed at, so it is about real code in front of them.`] : []),
        ...(forModel && ask.planMode === true ? [`- The chat opens in plan mode: it is being asked to think the work through before touching anything.`] : []),
    ];
    return facts.length === 0 ? [] : [``, `Facts about the chat:`, ...facts];
};

// The opening sentence names exactly what is being asked for, so a reading of one half never reads as a reading of two.
const headline = (asked: Asked): string => {
    if (asked.roles === undefined) {
        return `Choose the model a new chat should run on, reading the message it opens with.`;
    }
    return asked.offer === undefined
        ? `Choose which role should handle a new chat, reading the message it opens with.`
        : `Choose what a new chat opens on, reading the message it opens with: which role should handle it, and which model it should run on.`;
};

// The keyed lines the reply must carry, one per thing being chosen, and nothing for a half that isn't.
const replyContract = (asked: Asked): readonly string[] => {
    const lines = [
        ...(asked.roles === undefined ? [] : [`role: <one role id from the list above, or \`${NONE}\`>`]),
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
        ...roleAdvice(asked.roles, siteOf),
        ...modelAdvice(asked.offer, now, guidance),
        ...chatFacts(ask, asked),
        ``,
        `Opening message:`,
        excerpt(ask.prompt),
        ...replyContract(asked),
    ].join(`\n`);

// What one reply was read as. Each half is undefined when it wasn't asked for; inside the role half, an undefined
// `id` is a deliberate `none` rather than a failure.
export interface RouteVerdict {
    readonly model?: ParsedPick;
    readonly role?: { readonly id: string | undefined; readonly token: string };
}

// Wrapper words a model reaches for anyway around a bare id: a fence, a label, a bullet, quotes, a trailing period.
const LABEL = /^(?:role|id|answer)\s*:\s*/iu;

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

// The role the reply names: its own keyed line, else the bare word a one-question reply is allowed to be. A keyed
// reply that answered the model and skipped this line reads as `none` — the safe answer — rather than as a rung that
// ignored the list it was given.
const roleToken = (reply: string): string => {
    const fields = replyFields(reply, [`role`, `id`, `answer`, `model`, `effort`, `account`]);
    const named = fields.get(`role`) ?? fields.get(`id`) ?? fields.get(`answer`);
    if (named !== undefined) {
        return named.split(/\s+/u)[0] ?? ``;
    }
    return fields.size === 0 ? firstWord(reply) : NONE;
};

// Why this reply is unusable, or undefined when it answered what it was asked. A model not on the list and a role
// that is no role here are both a rung ignoring its list, stepped over so the next one answers rather than the chat
// running an id no provider has or acting as somebody nobody made.
const wrongAnswers = (verdict: RouteVerdict): readonly string[] => {
    const { model, role } = verdict;
    const badRole = role !== undefined && role.id === undefined && role.token.toLowerCase() !== NONE;
    const badModel = model !== undefined && model.pick === undefined;
    return [
        ...(badRole ? [`named "${role.token}", which is no role here`] : []),
        ...(badModel ? [model.token === `` ? `named no model at all` : `named "${model.token}", which is not on the list it was given`] : []),
    ];
};

// Matched case-insensitively; the lists themselves are the authority on spelling.
export const routeAnswer = (asked: Asked): RoleAnswer<RouteVerdict> => {
    const offer = asked.offer;
    const roles = asked.roles;
    const byLower = new Map((roles ?? []).map((role) => [role.id.toLowerCase(), role.id]));
    const wants = [...(roles === undefined ? [] : [`a role id or ${NONE}`]), ...(offer === undefined ? [] : [`a model from the list`])];
    return {
        what: wants.join(` and `),
        read: (reply) => {
            const token = roles === undefined ? undefined : roleToken(reply);
            return {
                ...(offer === undefined ? {} : { model: parseModelPick(reply, offer) }),
                ...(token === undefined ? {} : { role: { id: byLower.get(token.toLowerCase()), token } }),
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

// Roles whose folder the chat was opened in: those that start there or carry it as a repository.
const homedIn = (roles: readonly Role[], folder: string): readonly Role[] =>
    roles.filter((role) => role.workspace?.startIn === folder || role.context?.repos.includes(folder) === true);

const nameOf = (role: Role): string => role.label ?? role.id;

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

// The one deterministic shortcut, taken before any model is asked: a chat opened in a folder exactly one role works
// in is that role's chat.
const roleHalf = (roles: readonly Role[], folder: string | undefined): Half<readonly Role[], RoleVerdict> => {
    if (roles.length === 0) {
        return { settled: { reason: `No roles to route onto.` } };
    }
    const homed = folder === undefined ? [] : homedIn(roles, folder);
    const home = homed.length === 1 ? homed[0] : undefined;
    return home === undefined ? { ask: roles } : { settled: { id: home.id, reason: `Opened in ${folder}, which ${nameOf(home)} works in.` } };
};

const roleVerdict = (named: string | undefined, roles: readonly Role[]): RoleVerdict => {
    const role = roles.find((entry) => entry.id === named);
    return role === undefined ? { reason: `No role fits this message.` } : { id: role.id, reason: `The message reads like ${nameOf(role)}'s work.` };
};

const modelVerdict = (pick: ModelPick | undefined, offer: ModelOffer): ModelVerdict => {
    if (pick === undefined) {
        return { reason: `Couldn't choose a model for this chat, so it keeps the one it had.` };
    }
    const label = offer.models.find((model) => model.provider === pick.provider && model.model === pick.model)?.label ?? humanizeModelId(pick.model);
    return { pick, reason: `Read the opening message as work for ${pickWords(pick, label)}.` };
};

// The reply, as the two verdicts a chat can show. Only halves that were asked for are answered.
const verdicts = (verdict: RouteVerdict, asked: Asked): Partial<Pick<ChatRoute, "role" | "model">> => ({
    ...(asked.roles === undefined ? {} : { role: roleVerdict(verdict.role?.id, asked.roles) }),
    ...(asked.offer === undefined ? {} : { model: modelVerdict(verdict.model?.pick, asked.offer) }),
});

// A spent chain, an unset role, or the deadline: every half that was being read says why it has no answer. Whatever
// settled itself without a model still stands, and is merged over this by the caller.
const unread = (asked: Asked, why: string): Partial<Pick<ChatRoute, "role" | "model">> => ({
    ...(asked.roles === undefined ? {} : { role: { reason: `Couldn't read which role this chat belongs to: ${why}` } }),
    ...(asked.offer === undefined ? {} : { model: { reason: `Couldn't choose a model: ${why}` } }),
});

// New chat routing has no model set, which is how it is turned off. A chat nobody asked to route onto a role hears
// nothing about roles; one set to Auto is told which job picks its model, since it asked for exactly that.
const routingOff = (asked: Asked): Partial<Pick<ChatRoute, "role" | "model">> =>
    asked.offer === undefined
        ? {}
        : { model: { reason: `Auto picks a model only when "New chat routing" has one in Sandbox ▸ Agent ▸ Models, so this chat keeps the model it had.` } };

// Whether the ask wants the role half: `role`, else what an editor from before personas were renamed roles sent.
const asksRole = (ask: ChatRouteAsk): boolean => ask.role ?? ask.persona ?? false;

// Each half's own answer and what it still owes a model, from the lists this ask paid to have read.
const halves = (
    ask: ChatRouteAsk,
    offer: ModelOffer | undefined,
    roles: readonly Role[],
): { readonly asked: Asked; readonly settled: Partial<Pick<ChatRoute, "role" | "model">> } => {
    const model = ask.model ? modelHalf(offer) : {};
    const role = asksRole(ask) ? roleHalf(roles, ask.folder) : {};
    return {
        asked: { ...(model.ask === undefined ? {} : { offer: model.ask }), ...(role.ask === undefined ? {} : { roles: role.ask }) },
        settled: { ...(role.settled === undefined ? {} : { role: role.settled }), ...(model.settled === undefined ? {} : { model: model.settled }) },
    };
};

// `held` is the asker's areas, undefined for an unfenced one: the role half picks only from roles that person may
// actually wear, since routing onto one they cannot use would open the chat on a role every message is refused by.
// `asker` is the signed-in person's email, undefined for the owner's own tools: the model half picks only from the AI
// accounts that person may spend (Access ▸ People), since their turn is held to exactly those (account-reach.ts).
export const routeChat = async (
    services: Services,
    ask: ChatRouteAsk,
    held: readonly string[] | undefined,
    signal?: AbortSignal,
    assistants?: readonly string[],
    asker?: string,
): Promise<ChatRoute> => {
    // Read together, and only what this ask is paying for: an offer costs live allowance readings, which a chat that
    // only wants a role must not be charged for.
    const [offer, roles, settings] = await Promise.all([
        ask.model ? services.accountReach(undefined, asker === undefined ? [] : [asker]).then((reach) => autoOffer(services, undefined, reach)) : undefined,
        asksRole(ask) ? reachableRoles(services, held, assistants) : [],
        services.sandboxSettings.get(),
    ]);
    // What each half answered on its own; a reading, if one is still owed, is merged over it below.
    const { asked, settled } = halves(ask, offer, roles);
    if (asked.offer === undefined && asked.roles === undefined) {
        return settled;
    }
    const siteOf = asked.roles === undefined ? undefined : siteLookup(await services.capabilities.list());
    const deadline = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
    try {
        if (!(await roleModelIsSet(services, "model-router"))) {
            return { ...settled, ...routingOff(asked) };
        }
        const answer = await withAgentExecution(services.agentExecution, { localCwd: services.workspace.root }, (execution) =>
            askRoleModel(
                services,
                execution,
                "model-router",
                { prompt: routerPrompt(ask, asked, Date.now(), settings.autoModelGuidance, siteOf), answer: routeAnswer(asked) },
                deadline,
            ),
        );
        // Named whether or not anything was chosen: the reading was paid for either way, and the chat says so.
        return { ...settled, ...verdicts(answer.value, asked), judge: modelPinKey(answer.choice) };
    } catch (error: unknown) {
        if (error instanceof AgentDomainRefusedError) { throw error; }
        // Routing simply switched off (no model for the job) is a setting, not a failure: nothing is said about the
        // role, and the model half, asked for only by a chat set to Auto, gets a plain note naming the job.
        if (error instanceof RoleModelUnsetError) {
            return { ...settled, ...routingOff(asked) };
        }
        services.logger.warn({ err: error }, "chat router: no answer, the chat keeps what it had");
        return { ...settled, ...unread(asked, errorMessage(error)) };
    }
};
