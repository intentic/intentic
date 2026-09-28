import type { Need, NeedAnswer, NeedAsk, NeedKind, NeedSubject } from "@intentic/sandbox-contract";
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

// A need met: the daemon's sentence on how, and what the agent can do with it now and next turn.
export interface Met {
    readonly result: string;
    readonly use: readonly string[];
}

// Who answered, as the request verified them.
export interface Answerer {
    readonly email: string | undefined;
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
    // Whether the need is met now, looked up fresh. Undefined means not yet.
    readonly check: (need: Need) => Promise<Met | undefined>;
    // A person's answer other than a decline, which needs.ts handles for every kind alike.
    readonly answer: (need: Need, answer: Exclude<NeedAnswer, { kind: "decline" }>, by: Answerer) => Promise<Answered>;
    // Who may answer at all, yes or no, when the kind names them (a release's approvers): the reason a click from
    // anybody else is refused, leaving the need waiting for somebody who can. Absent: anyone who reaches the route.
    readonly mayAnswer?: (need: Need, by: Answerer) => string | undefined;
    // What a decline undoes, where the kind left something behind (a drafted overlay step).
    readonly declined?: (need: Need) => Promise<void>;
    // Whether a met need only reaches the agent on its conversation's next turn: a grant, a release, an account a turn
    // mounts at its start. Such a need continues the conversation once its current turn ends.
    readonly nextTurn: (need: Need) => boolean;
    // Two asks are the same need when this key matches, so asking twice finds the first rather than raising again.
    readonly key: (subject: NeedSubject) => string;
}

export type NeedKinds = Readonly<Record<NeedKind, NeedKindHandler>>;
