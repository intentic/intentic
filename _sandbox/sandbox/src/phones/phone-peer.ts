import { wrapOutsideContent } from "@intentic/base/outside-text";
import {
    type Capability,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    hardRuleClasses,
    matchCommand,
    PHONE_HEARTBEAT_MS,
    PHONE_WAKE_WAIT_MS,
    type PhoneFacts,
    type PhoneHello,
    PhoneHelloSchema,
    type phoneContract,
    type PhoneScopes,
    PhoneScopesSchema,
    type PhoneSummary,
    PhoneWakeRegistrationSchema,
} from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import { phoneEnrollmentsDocument, phonePairConsumedDocument } from "../peers/enrollment.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { PhoneJsonRpcLink } from "./json-rpc-link.js";

// The user's own phone as a peer door, through the Intentic Device app that dials this sandbox and answers
// `phoneContract` as JSON-RPC (json-rpc-link.ts). A phone is asleep most of the time, so this door is the one that can
// wake its peer: a tool call to a phone holding no socket pushes it awake (phone-wake.ts) and waits for it to dial in.
// Screen text, notifications and app names are wrapped as outside content here, not on the phone, so a tampered app
// cannot skip the seal.

export type PhoneClient = ContractRouterClient<typeof phoneContract>;
export interface PhoneAnnounced {
    readonly version: string;
}
export type PhoneHub = PeerHub<PhoneClient, PhoneAnnounced, PhoneFacts, PhoneScopes>;
export type PhoneStore = PeerStore<Record<string, never>>;

// How long `describe` may run before the card falls back to the last answer: a phone on a slow link must not stall it.
const DESCRIBE_TIMEOUT_MS = 3_000;

export const PHONE_PEER: PeerDoor<PhoneHello, PhoneAnnounced, Record<never, never>> = {
    slug: PEER_BRIDGES.phone,
    noun: "phone",
    listKey: "phones",
    store: {
        documents: { enrollments: phoneEnrollmentsDocument, consumed: phonePairConsumedDocument },
        key: "phones",
        prefix: "iph_",
        extra: {},
    },
    hub: {
        domain: "phones",
        heartbeatMs: PHONE_HEARTBEAT_MS,
        callTimeoutMs: 10 * 60 * 1000,
        offline: (id) =>
            `"${id}" is asleep and did not come when woken: the phone is switched off, has no signal, or its Intentic Device app is not set up to be woken. Say so and stop; do not retry in a loop.`,
    },
    hello: { schema: PhoneHelloSchema, announced: (hello) => ({ version: hello.version }) },
    scopesKind: "phone",
    mcp: { serverName: (id) => `intentic-phone:${id}` },
    expired: "that code has expired: click Connect on the phone's card in your sandbox for a fresh one.",
};

// Tools whose answer is the app's own voice, unsealed; everything else carries text the screen, another app or a
// notification wrote, and is sealed. An allowlist, fail-closed.
const OWN_VOICE = new Set(["describe", "ask_access", "write_file", "trash_file", "clipboard"]);

// One MCP result, sealed. Text blocks only: an image has no marker to forge.
export const sealAnswer = (id: string, tool: string, answer: unknown): unknown => {
    if (OWN_VOICE.has(tool)) {
        return answer;
    }
    const envelope = answer as { result?: { content?: unknown } };
    const content = envelope.result?.content;
    if (!Array.isArray(content)) {
        return answer;
    }
    return {
        ...envelope,
        result: {
            ...envelope.result,
            content: content.map((block) => {
                const part = block as { type?: unknown; text?: unknown };
                return part.type === "text" && typeof part.text === "string"
                    ? Object.assign({}, part, { text: wrapOutsideContent(part.text, { source: `phone:${id}` }) })
                    : block;
            }),
        },
    };
};

// The text a call would type into whatever field has focus on the phone, or undefined for any other call.
export const typedOnPhone = (payload: unknown): string | undefined => {
    const message = payload as { method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } } | undefined;
    const args = message?.params?.arguments;
    if (message?.method !== "tools/call") {
        return undefined;
    }
    const typed =
        (message.params?.name === "ui_act" && (args?.["action"] === "type" || args?.["action"] === "set_text")) ||
        message.params?.name === "clipboard"
            ? args?.["text"]
            : undefined;
    return typeof typed === "string" && typed.trim() !== "" ? typed : undefined;
};

// The one check the app cannot make itself: whether typed text is a destructive command, by the same classifier that
// judges a computer's shell (a terminal app on the phone runs what is typed into it). It only tightens: with the card's
// "Destructive actions" switch off such text never crosses; with it on the phone's own rules still decide.
export const phoneTypingRefusal = (phone: string, text: string, scopes: Pick<PhoneScopes, "destructive"> | undefined): string | undefined => {
    if (scopes?.destructive === "on") {
        return undefined;
    }
    const gated: CommandClass[] = matchCommand(text, { locus: "device" })
        .filter((match) => match.live && hardRuleClasses("device").has(match.commandClass))
        .map((match) => match.commandClass);
    if (gated.length === 0) {
        return undefined;
    }
    return (
        `Refused: typed on "${phone}", this would ${gated.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")}, ` +
        `and the phone's "Destructive actions" switch is off. Ask the owner with \`capabilities request ${phone} --set destructive=on\`, ` +
        `or type something that does not delete. Do not look for another spelling that gets past it.`
    );
};

const phoneScopesOf = async (services: Pick<Services, "capabilities">, id: string): Promise<PhoneScopes | undefined> => {
    const capability = (await services.capabilities.list()).find((entry) => entry.kind === "phone" && entry.id === id);
    const parsed = capability === undefined ? undefined : PhoneScopesSchema.safeParse(capability.config);
    return parsed?.success === true ? parsed.data : undefined;
};

// The owner's view of their phones: manifest capabilities plus what the hub can say right now, and whether each can be
// woken. Enrollment state (added-but-unpaired vs paired-but-asleep) stays distinguishable through `online`/`lastSeen`.
export const phoneSummaries = async (services: Pick<Services, "capabilities" | "phoneHub" | "phoneWake">): Promise<PhoneSummary[]> =>
    await Promise.all(
        (await services.capabilities.list()).flatMap((capability) =>
            capability.kind !== "phone"
                ? []
                : [
                      (async (): Promise<PhoneSummary> => {
                          await services.phoneHub.refresh(capability.id, DESCRIBE_TIMEOUT_MS);
                          const state = services.phoneHub.state(capability.id);
                          return {
                              id: capability.id,
                              platform: capability.config.platform,
                              online: state.online,
                              wake: await services.phoneWake.state(capability.id, state.facts),
                              ...(state.announced === undefined ? {} : { version: state.announced.version }),
                              ...(state.facts === undefined ? {} : { facts: state.facts }),
                              ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
                          };
                      })(),
                  ],
        ),
    );

// One of the owner's phones as a turn needs to know it: the name its tools are prefixed with, and what it is ("Google
// Pixel 8"), from its last `describe`.
export interface OwnPhone {
    readonly id: string;
    readonly what?: string | undefined;
}

// Granted phone cards, split like browsers by whether they publish tools: `phones` have a tool table (connected now or
// remembered), `unlisted` were added but never paired. A phone asleep in a pocket is a `phones` entry: it is woken on
// its first call.
export interface OwnPhoneReach {
    readonly phones: readonly OwnPhone[];
    readonly unlisted: readonly string[];
}

const listsTools = (known: unknown): boolean => {
    const tools = (known as { readonly tools?: unknown } | undefined)?.tools;
    return Array.isArray(tools) && tools.length > 0;
};

// Reads only what the hub already holds, so composing a turn never waits on a phone.
export const ownPhoneReach = async (
    services: { readonly phoneHub: Pick<PhoneHub, "state" | "online" | "knownTools"> },
    granted: readonly Capability[],
): Promise<OwnPhoneReach | undefined> => {
    const cards = granted.filter((capability) => capability.kind === "phone");
    if (cards.length === 0) {
        return undefined;
    }
    const hub = services.phoneHub;
    const publishing = cards.filter((card) => hub.online(card.id) || listsTools(hub.knownTools(card.id)));
    return {
        phones: publishing.map((card): OwnPhone => {
            const what = hub.state(card.id).facts?.device;
            return { id: card.id, ...(what === undefined ? {} : { what }) };
        }),
        unlisted: cards.filter((card) => !publishing.includes(card)).map((card) => card.id),
    };
};

export const phonePeerRoutes = (services: Services) =>
    createPeerRoutes(services, PHONE_PEER, {
        store: services.phones,
        hub: services.phoneHub,
        summaries: () => phoneSummaries(services),
        sealAnswer,
        client: (socket) => createORPCClient(new PhoneJsonRpcLink(socket)) as unknown as PhoneClient,
        wake: { send: (id) => services.phoneWake.send(id), waitMs: PHONE_WAKE_WAIT_MS },
        beforeCall: async (payload, call) => {
            const typed = typedOnPhone(payload);
            if (typed === undefined) {
                return undefined;
            }
            const refusal = phoneTypingRefusal(call.id, typed, await phoneScopesOf(services, call.id));
            return refusal === undefined ? undefined : { refusal };
        },
    });

// POST /system/phones/{id}/wake: the editor hands over the relay channel it registered for this phone's token. The
// operating gate, as minting a pairing is: whoever may pair the phone may make it wakeable.
export const createPhoneWakeRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        if (!(await services.phones.enrolled(id))) {
            return c.json({ error: "no paired phone with that id" }, 404);
        }
        // allow(silent-catch): a body that is not JSON is answered as the 400 just below
        const parsed = PhoneWakeRegistrationSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "expected { token, channel } with a relay channel" }, 400);
        }
        await services.phoneWake.register(id, parsed.data);
        return c.json({ ok: true });
    };
