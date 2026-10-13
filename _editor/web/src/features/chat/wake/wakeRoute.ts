// Where words said to the agent by name go: on into a conversation already under way, or into a new session. Pure, so
// the rule can be read and pinned in one place; the listener gathers the situation and does what this answers.
//
// The rule leans to a new session. Every conversation is its own worktree and its own context: a request carried into
// the wrong one mixes two pieces of work into one change and muddles what the agent knows, and neither is easy to take
// back, while a session nobody needed is one more card on the board. So words go on into a conversation only on a clear
// sign of an exchange under way:
// 1. "Leon, new session …" asks for a new one outright.
// 2. A question card waiting in a conversation the person is talking to (the one the last wake went to, or the one on
//    screen) takes the words as its answer, as hands-free voice does.
// 3. The conversation the last wake went to, while that exchange is recent: "Leon, and add tests too".
// 4. The conversation on screen, while something was said in it recently or a turn runs in it.
// 5. Anything else is a new session: calling a name after a long while is almost always a new topic.

/** How long after the last thing said in a conversation it still counts as the exchange under way. */
export const FOLLOW_UP_MS = 10 * 60_000;

/** One conversation as the rule reads it. */
export interface WakeTarget {
    readonly id: string;
    /** A card in it waits for the person's answer. */
    readonly asking: boolean;
    /** A turn runs in it now. */
    readonly running: boolean;
    /** When anything was last said in it, by either side (epoch ms); undefined for a chat with nothing in it. */
    readonly lastSaidAt: number | undefined;
}

export interface WakeSituation {
    readonly now: number;
    /** The request opened by asking for a new session. */
    readonly askedForNew: boolean;
    /** The conversation the last wake went to, while it is still open in this window. */
    readonly thread: WakeTarget | undefined;
    /** The conversation in front of the person: the focused chat, while the page is on screen. */
    readonly onScreen: WakeTarget | undefined;
}

export type WakeRoute =
    | { readonly kind: `answer`; readonly id: string; readonly why: `thread` | `screen` }
    | { readonly kind: `continue`; readonly id: string; readonly why: `thread` | `screen` }
    | { readonly kind: `new`; readonly why: `asked` | `nothing-recent` };

/** Something was said in it within the follow-up window, or it is working now. */
export const recent = (target: WakeTarget, now: number): boolean =>
    target.running || (target.lastSaidAt !== undefined && now - target.lastSaidAt < FOLLOW_UP_MS);

export const routeWake = ({ now, askedForNew, thread, onScreen }: WakeSituation): WakeRoute => {
    if (askedForNew) {
        return { kind: `new`, why: `asked` };
    }
    const live = (target: WakeTarget | undefined): target is WakeTarget => target !== undefined && recent(target, now);
    if (live(thread) && thread.asking) {
        return { kind: `answer`, id: thread.id, why: `thread` };
    }
    if (live(onScreen) && onScreen.asking) {
        return { kind: `answer`, id: onScreen.id, why: `screen` };
    }
    if (live(thread)) {
        return { kind: `continue`, id: thread.id, why: `thread` };
    }
    if (live(onScreen)) {
        return { kind: `continue`, id: onScreen.id, why: `screen` };
    }
    return { kind: `new`, why: `nothing-recent` };
};

/** The other place the same words could go, for the switch offered while they wait to be sent. */
export const alternativeOf = (route: WakeRoute, situation: WakeSituation): WakeRoute | undefined => {
    if (route.kind !== `new`) {
        return { kind: `new`, why: `asked` };
    }
    // From a new session back to the conversation that was nearest to being continued: the last wake's, else the one on screen.
    const back = situation.thread ?? situation.onScreen;
    return back === undefined ? undefined : { kind: `continue`, id: back.id, why: situation.thread === undefined ? `screen` : `thread` };
};

// The last moment anything was said in a run of rows: a person's rows carry `sentAt`, the agent's and notices `openedAt`.
export const lastSaidAt = (rows: readonly { readonly sentAt?: number; readonly openedAt?: number }[]): number | undefined => {
    let latest: number | undefined;
    // The newest rows are at the end, and the clock only moves forward along them; a few from the end is enough unless
    // they are unstamped (older records), so the scan goes on until a stamp is found.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const at = row?.sentAt ?? row?.openedAt;
        if (at !== undefined) {
            latest = Math.max(latest ?? 0, at);
            if (rows.length - index > 4) {
                break;
            }
        }
    }
    return latest;
};
