import type { Need, NeedAnswer, NeedAsk, NeedKind, NeedSecretInputSchema, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { z } from "zod";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";

// What each kind of need knows how to do (kinds/*.ts), so needs.ts stays one lifecycle for all of them: turn an
// agent's ask into the daemon's own subject, tell when a need is met, carry out a person's answer.

// The raising turn, as far as an ask is answered by it.
export interface AskContext {
    readonly conversationId: string;
    // Undefined when the conversation has no turn this daemon planned (a shell outside any turn).
    readonly standing: TurnStanding | undefined;
}

// What an ask comes to. `met`: nothing to raise, it is usable already, and `message` says how. `refused`: nothing
// raised, and `message` says why and what to do instead. `raise`: the daemon's subject and title for a new need.
export type Resolved =
    | { readonly kind: "met"; readonly message: string }
    | { readonly kind: "refused"; readonly code: string; readonly message: string }
    | { readonly kind: "raise"; readonly subject: NeedSubject; readonly title: string };

// "Keep it on my computer" on a secret need's card (NeedSecretInputSchema `keepOn`): which computer's keyring keeps the
// value, and how that keyring answers this sandbox for it.
export type SecretKeepOn = NonNullable<z.infer<typeof NeedSecretInputSchema>["keepOn"]>;

// A need met: the daemon's sentence on how, and what the agent can do with it now and next turn.
export interface Met {
    readonly result: string;
    readonly use: readonly string[];
}

// A need whose subject was answered elsewhere: what the conversation is told when it is declined for it.
export interface Gone {
    readonly gone: string;
}

export const isGone = (checked: Met | Gone | undefined): checked is Gone => checked !== undefined && "gone" in checked;

// Who answered, as the request verified them.
export interface Answerer {
    readonly email: string | undefined;
    // The agent itself (`needs done`): it already knows, so it is never told, and the record says whose word it was.
    readonly agent?: true;
    // (2026-11-22) The request's own bearer clears the maintainer floor, checked the way the doors that act on a connected
    // device check it (owner-gates.ts `requireMaintainer`): the owner, or someone with Full access, signed in. The answer
    // route's floor already keeps every member below that out, but a machine credential the route's grants admit (an
    // operator panel's token, an extension's) arrives there with nobody behind it. A kind whose yes changes one of the
    // owner's computers (host-power) asks for this instead. Absent: not vouched for, which such a kind reads as no.
    readonly maintainer?: true;
}

// What a person's answer did. `met` and `declined` settle the need; `working` is a yes still being carried out (a
// connection's form open, an overlay approved but not built); `refused` leaves it waiting, with the reason.
export type Answered =
    | ({ readonly status: "met" } & Met)
    | { readonly status: "working"; readonly subject?: NeedSubject }
    | { readonly status: "declined"; readonly result: string }
    | { readonly refused: string };

export interface NeedKindHandler {
    readonly resolve: (ask: NeedAsk, context: AskContext) => Promise<Resolved>;
    // Whether the need is met now, looked up fresh. Undefined means not yet; `gone` means it never will be, because what it
    // asked for was turned down or taken away somewhere other than its own card (the need is declined with that sentence,
    // rather than left offering an answer nothing can act on any more).
    readonly check: (need: Need) => Promise<Met | Gone | undefined>;
    // A person's answer other than a decline, which needs.ts handles for every kind alike.
    readonly answer: (need: Need, answer: Exclude<NeedAnswer, { kind: "decline" }>, by: Answerer) => Promise<Answered>;
    // Who may answer at all, yes or no, when the kind names them (a release's approvers): the reason a click from
    // anybody else is refused, leaving the need waiting for somebody who can. Absent: anyone who reaches the route.
    readonly mayAnswer?: (need: Need, by: Answerer) => string | undefined;
    // Whether the agent's own word may close an open need as met (`needs done`): only where nothing `check` reads can
    // ever see it met, so a person's "it is fixed" said in the chat, and a retry that worked, are all there is. Absent:
    // never, since the daemon closes the need itself the moment it is met.
    readonly agentMayClose?: (need: Need) => boolean;
    // What a decline undoes, where the kind left something behind (a drafted overlay step).
    readonly declined?: (need: Need) => Promise<void>;
    // Whether a met need only reaches the agent on its conversation's next turn: a grant, a release, an account a turn
    // mounts at its start. Such a need continues the conversation once its current turn ends.
    readonly nextTurn: (need: Need) => boolean;
    // Two asks are the same need when this key matches, so asking twice finds the first rather than raising again.
    readonly key: (subject: NeedSubject) => string;
    // (2026-11-22) False for a need the daemon raises for a person about a conversation, never for its agent: a host-power
    // card, raised when work booked for later would be slept through. However it ends, nothing is steered into a running
    // turn and no turn is woken to hear it, at the answer, at the end of a turn or at boot: a woken turn spends an
    // allowance, and here it would also run the booked work hours early, the very thing the card is about. The agent
    // never deals with it either: `needs` leaves it out, and `needs cancel` and `needs done` refuse it, since it was
    // never the agent's to ask or to take back. Its card, its push and the board's badge are as any need's. Absent: the
    // agent is told, as it is of every need it asked.
    readonly tellsAgent?: false;
    // (2026-11-25) The outcome that sets the conversation going again when no call is holding for it, where it is not a
    // met need's: `declined` wakes it for a no (steered into a live turn, else a turn of its own) and tells it nothing of a
    // yes. A redirect is this way round: sent on to another sandbox, nothing is left to do here and a woken turn would
    // spend an allowance to say so; kept here, the person is asking the agent to get on with it. Absent: a yes wakes it, a
    // no reaches only a live turn.
    readonly wakesOn?: "declined";
}

// Whether the conversation's agent hears of this need at all (`tellsAgent`). Pure.
export const agentHears = (kinds: NeedKinds, need: Pick<Need, "subject">): boolean => kinds[need.subject.kind].tellsAgent !== false;

export type NeedKinds = Readonly<Record<NeedKind, NeedKindHandler>>;
