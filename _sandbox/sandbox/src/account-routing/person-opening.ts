import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import type { Holding } from "../conversations/actor/conversation-holdings.js";
import type { DomainEventMap } from "../seams/domain-events.js";

/* THE WORDS A PERSON LAST OPENED A TURN WITH, per conversation (2026-11-25, docs/architecture/account-routing.md): what a
 * redirect card offers to send on to the sandbox the message was meant for (needs/kinds/redirect-need.ts). Kept by the
 * daemon from the turn it started, never taken from the agent, so the card carries what the person typed and not a
 * retelling of it. A re-run the sandbox fired by itself keeps the words it re-runs; a turn something else opened (a
 * child's report, an automation, a peer's message) leaves the person's last words as they were. Held in memory: after a
 * restart there is nothing to offer until the person speaks again. */

export interface PersonOpening {
    // Who typed them, as the sandbox verified their sign-in.
    readonly email: string;
    readonly words: string;
    // How many files went with them, which a redirect leaves behind.
    readonly attachments: number;
    readonly at: number;
}

type Actors = Pick<ConversationActors, "holdings">;

// One per conversation, under the conversation's own id: the person's next message replaces it.
const PERSON_OPENING: Holding<PersonOpening> = { name: "person opening" };

/** Keeps a person's words when a turn they opened starts (`run.started`); anything else is left alone. */
export const notePersonOpening = (actors: Actors, started: DomainEventMap["run.started"], now: number = Date.now()): void => {
    const { speaker } = started;
    if (speaker?.kind !== "person" || started.resume !== undefined) {
        return;
    }
    const opening: PersonOpening = { email: speaker.email.toLowerCase(), words: started.prompt, attachments: started.attachments ?? 0, at: now };
    actors.holdings(PERSON_OPENING).hold(started.conversationId, started.conversationId, opening);
};

/** The words a person last opened a turn of this conversation with, or undefined when none are held. */
export const personOpeningOf = (actors: Actors, conversationId: string): PersonOpening | undefined =>
    actors.holdings(PERSON_OPENING).get(conversationId);
