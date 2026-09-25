import { speakerActor, speakerOwner, type TurnSpeaker } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import type { Principal } from "../auth/principal.js";
import type { TurnInput } from "./turn-starter.js";

// Who is speaking, built once at a door from what the middleware verified on the request, never from the body: a
// signed-in member is a person, a control token's holder a program. The one-line facts older readers take (the turn's
// `actor`, the conversation's `owner`) are derived from it here, so they can never disagree with it.

/** The verified speaker behind a request; undefined for a caller the sandbox cannot name (a per-boot secret). */
export const speakerOf = (identity: Caller | undefined, principal: Principal | undefined): TurnSpeaker | undefined => {
    if (identity !== undefined) {
        return { kind: "person", email: identity.email, ...(identity.name === undefined ? {} : { name: identity.name }) };
    }
    return principal === undefined ? undefined : { kind: "program", token: principal.label };
};

/** A turn's attribution from its speaker: the speaker itself, and the actor and owner derived from it. */
export const spokenBy = (speaker: TurnSpeaker | undefined): Pick<TurnInput, "speaker" | "actor" | "owner"> => {
    if (speaker === undefined) {
        return {};
    }
    const actor = speakerActor(speaker);
    const owner = speakerOwner(speaker);
    return { speaker, ...(actor === undefined ? {} : { actor }), ...(owner === undefined ? {} : { owner }) };
};
