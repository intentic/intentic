import { sleep } from "@intentic/base/async";
import type { TurnSpeaker } from "@intentic/sandbox-contract/schemas/speaker";
import type { Services } from "../../composition.js";
import { provenanceOf } from "../../auth/fleet-scope.js";
import { mentionedYou } from "../../push/notifications.js";
import { peopleAudience } from "../../push/push-audience.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { mentionedIn, type Person } from "./participation.js";

// TAKING PART, at the doors where a person's words reach a conversation outside a turn's opening (whose asker the
// registry counts itself as the turn begins, agents-registry.ts socialOf): a steer into a running turn, an answer to a
// card, and the people a message names with @, who are brought in and told so once. Never throws: who took part is
// bookkeeping beside the words, which have already gone where they were sent.

type PartServices = Pick<Services, "agents" | "members" | "ownerEmail" | "pushSender" | "logger">;

// A turn's record opens as the turn begins, a moment after its run starts; its mentions wait this long for it, then go
// unsaid rather than told to people the conversation's own fence was never read for.
const RECORD_WAIT_MS = 10_000;
const RECORD_POLL_MS = 200;

const recordOf = async (services: PartServices, conversationId: string): Promise<PersistedAgent | undefined> => {
    for (let waited = 0; waited <= RECORD_WAIT_MS; waited += RECORD_POLL_MS) {
        const entry = services.agents.entry(conversationId);
        if (entry !== undefined) {
            return entry;
        }
        await sleep(RECORD_POLL_MS);
    }
    return undefined;
};

/**
 * The members a person's message names with `@` and an address: each takes part from now on and hears so once, on
 * their devices whether or not they are at a screen, since an @ is a person calling them by name. Only members the
 * conversation is shown to are told (push.ts), and never the person who wrote it.
 */
const bringInMentioned = async (services: PartServices, conversationId: string, by: Person, text: string): Promise<void> => {
    if (!text.includes("@")) {
        return;
    }
    try {
        const [owner, members] = await Promise.all([services.ownerEmail(), services.members.list()]);
        const roster = [...(owner === undefined ? [] : [owner]), ...members.map((member) => member.email)];
        const named = mentionedIn(text, roster).filter((email) => email !== by.email.toLowerCase());
        const entry = named.length === 0 ? undefined : await recordOf(services, conversationId);
        if (entry === undefined) {
            return;
        }
        for (const email of named) {
            await services.agents.join(conversationId, { email }, "mention", Date.now());
        }
        const notice = mentionedYou(conversationId, by.name ?? by.email, entry.social.title?.text, text);
        await services.pushSender.notify(notice, peopleAudience(named, provenanceOf(entry)));
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "the people a message named could not be brought in");
    }
};

/** A run started (seams/domain-events.ts `run.started`): whoever a person's message names is brought in. A re-run names nobody anew. */
export const mentionsOfRun = async (
    services: PartServices,
    started: { readonly conversationId: string; readonly speaker: TurnSpeaker | undefined; readonly prompt: string; readonly resume: unknown },
): Promise<void> => {
    if (started.speaker?.kind === "person" && started.resume === undefined) {
        await bringInMentioned(services, started.conversationId, { email: started.speaker.email, name: started.speaker.name }, started.prompt);
    }
};

/**
 * A person's words reached the conversation outside a turn's opening: a steer (with whom it names) or a card's answer.
 * Nothing to record without a conversation the card was held by, or a person behind the request (the owner's own tools).
 */
export const takePart = async (
    services: PartServices,
    conversationId: string | undefined,
    by: Person | undefined,
    how: { readonly steer: string } | "answer",
): Promise<void> => {
    if (conversationId === undefined || by === undefined) {
        return;
    }
    try {
        await services.agents.join(conversationId, by, how === "answer" ? "answer" : "prompt", Date.now());
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "who took part could not be recorded");
    }
    if (how !== "answer") {
        await bringInMentioned(services, conversationId, by, how.steer);
    }
};
