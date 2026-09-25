import type { ParkKind, TurnSpeaker, WorkspaceEvent } from "@intentic/sandbox-contract";

// What a turn and the fleet announce, delivered in-process to whatever reacts to it: a publisher names only the event,
// and each reacting subsystem is subscribed in composition, so neither imports the other.

// Every event by name, with what it carries.
export interface DomainEventMap {
    // A worktree turn settled, a land reached the tree, the dependency check moved: what chores fire on.
    readonly workspace: WorkspaceEvent;
    // A detached run ended, however it ended: every run, whoever started it.
    readonly "run.settled": {
        readonly conversationId: string;
        // Who asked for the turn (seams/turn-starter.ts); undefined for one the daemon started itself.
        readonly actor: string | undefined;
        // The same, typed: what tells a person at the keyboard from a program holding a token they minted.
        readonly speaker: TurnSpeaker | undefined;
        // Undefined for a run that ended well or was stopped.
        readonly failure: string | undefined;
        // Its last top-level prose; empty when it said nothing.
        readonly closing: string;
    };
    // A turn begun through the port's `start` parked on its person; may happen several times a turn.
    readonly "turn.awaiting": { readonly conversationId: string; readonly awaiting: ParkKind };
    // That same turn ended, exactly once; `error` only for a real failure, a stop ends it clean.
    readonly "turn.finished": {
        readonly conversationId: string;
        readonly prompt: string;
        readonly outcome: { readonly ok: boolean; readonly error?: string };
    };
    // A turn changed the main tree, by running on it or by landing there; `label` is the words that caused it.
    readonly "tree.changed": { readonly label: string };
}

export type DomainEventName = keyof DomainEventMap;

export interface DomainEvents {
    // Synchronous: every subscriber runs before this returns, in the order it subscribed, so an announcement made before
    // another is reacted to before it too. A subscriber's throw or rejection is reported and never reaches the publisher.
    readonly publish: <K extends DomainEventName>(name: K, event: DomainEventMap[K]) => void;
    // Answers the unsubscribe.
    readonly subscribe: <K extends DomainEventName>(name: K, listener: (event: DomainEventMap[K]) => unknown) => () => void;
}

// Each event's subscribers, in the order they subscribed; one set per name, so a new event cannot go unheard.
type Subscribers = { readonly [K in DomainEventName]: Set<(event: DomainEventMap[K]) => unknown> };

export const createDomainEvents = (failed: (name: DomainEventName, error: unknown) => void): DomainEvents => {
    const subscribers: Subscribers = {
        workspace: new Set(),
        "run.settled": new Set(),
        "turn.awaiting": new Set(),
        "turn.finished": new Set(),
        "tree.changed": new Set(),
    };
    return {
        // A subscriber added or removed during delivery waits for the next announcement.
        publish: (name, event) => {
            // oxlint-disable-next-line unicorn/no-useless-spread -- The spread snapshots the subscribers before delivery.
            for (const listener of [...subscribers[name]]) {
                try {
                    const answered = listener(event);
                    if (answered instanceof Promise) {
                        answered.catch((error: unknown) => failed(name, error));
                    }
                } catch (error) {
                    failed(name, error);
                }
            }
        },
        subscribe: (name, listener) => {
            subscribers[name].add(listener);
            return () => {
                subscribers[name].delete(listener);
            };
        },
    };
};
