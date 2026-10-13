import {
    chunkMessage,
    type ListenerDispatchFrame,
    type Logger,
    MESSAGE_LIMITS,
    tablesToCode,
    trackTurnProgress,
    type TurnProgress,
    type TurnProgressTracker,
} from "@intentic/connector-runtime";
import { type CardView, type ProgressDetail, renderCard } from "./card.js";
import { addThreadMember, type DiscordRest, editMessage, type MessageBody, NO_PINGS, postMessage, react, startThread, typing, unreact } from "./discord-rest.js";
import type { Route } from "./inbound.js";

// One addressed message's answer in Discord, from the moment it is heard to the moment its turn ends. Heard: 👀 on the
// message and "typing…" in the room. Answered: a thread opened from the message when it needs one (only once something
// answers, so a message no automation takes leaves no empty thread), a status card that appears once the work outlasts
// a quick reply and is edited in place as the agent works, the reply posted as ordinary messages (cut at code-aware
// seams), and ✅, ❌, ✋ or ⏳ on the message to say how it stands. One view per automation that answers it, sharing the
// message's thread and reactions.

const DISCORD_MAX = MESSAGE_LIMITS.discord;

export const EMOJI = { heard: "👀", done: "✅", failed: "❌", held: "✋", queued: "⏳", stopped: "⏹️" } as const;

// The clock and cadences a reply runs on; tests shrink them.
export interface ReplyTiming {
    // How long a turn may work before its card appears: a quick answer posts none.
    readonly cardAfterMs: number;
    // The least time between two edits of one card (Discord limits edits per channel).
    readonly editEveryMs: number;
    // How often a card's elapsed time is refreshed while nothing else changes on it.
    readonly refreshEveryMs: number;
    // How often "typing…" is said again; Discord drops it after about ten seconds.
    readonly typingEveryMs: number;
    // How long "typing…" may run for one message at most.
    readonly typingMaxMs: number;
    // A turn that ran longer than this names its asker in the reply, so they hear it finished.
    readonly mentionAfterMs: number;
    readonly now: () => number;
}

export const REPLY_TIMING: ReplyTiming = {
    cardAfterMs: 1_500,
    editEveryMs: 2_000,
    refreshEveryMs: 15_000,
    typingEveryMs: 8_000,
    typingMaxMs: 30 * 60_000,
    mentionAfterMs: 60_000,
    now: Date.now,
};

// What a running turn lets the rest of the gateway do to it: the Stop button marks who pressed it, and a message steered
// into it is answered by it, so it takes that message's reactions too.
export interface RunControl {
    readonly stopping: (by: string) => void;
    readonly adopt: (message: { readonly channelId: string; readonly id: string }) => void;
}

export interface ReplyRegistry {
    readonly opened: (conversationId: string, room: string, run: RunControl) => void;
    readonly closed: (conversationId: string, room: string) => void;
    readonly running: (room: string) => RunControl | undefined;
}

export interface ReplyDeps {
    readonly rest: DiscordRest;
    readonly log: Logger;
    readonly detail: ProgressDetail;
    readonly registry: ReplyRegistry;
    // Remembers a thread the bot answered in, so its follow-ups are heard without a mention.
    readonly joined: (threadId: string) => void;
    readonly timing?: ReplyTiming;
}

export interface ReplyTarget {
    // The message being answered, and the room it was posted in.
    readonly messageId: string;
    readonly channelId: string;
    readonly authorId: string;
    readonly route: Route;
}

export interface MessageReply {
    readonly frame: (frame: ListenerDispatchFrame) => void;
    // The dispatch is over (every turn ended, or nothing took the message): settle reactions and stop typing.
    readonly settle: () => Promise<void>;
}

// A short line the agent says before it acts, which reads better on the card than as a message of its own.
const NARRATION_MAX = 280;
export const isNarration = (text: string): boolean => text.length <= NARRATION_MAX && !text.includes("```") && text.split("\n").length <= 2;

// One automation's turn answering the message: the frames it is handed, and whether its turn has said it ended.
interface RunView {
    readonly frame: (frame: ListenerDispatchFrame) => void;
    readonly ended: () => boolean;
}

// What a thread is told when the sandbox stopped streaming a turn before it ended (a restart, a dropped connection).
export const LOST_NOTICE = "I lost the connection to the sandbox before this finished; open the conversation in Intentic to see how it ended.";

// How a run ended, for the message's reactions.
type Outcome = "done" | "failed" | "held" | "stopped";

// A turn that never opened and said nothing about why answered nothing, so it leaves no mark of its own.
const outcomeOf = (state: TurnProgress, stoppedBy: string | undefined): Outcome | undefined => {
    if (stoppedBy !== undefined) {
        return "stopped";
    }
    if (state.failed !== undefined) {
        return "failed";
    }
    if (state.opened !== undefined) {
        return "done";
    }
    return state.held === undefined ? undefined : "held";
};

export const createMessageReply = (deps: ReplyDeps, target: ReplyTarget): MessageReply => {
    const timing = deps.timing ?? REPLY_TIMING;
    const { rest, log } = deps;
    // Every write for this message goes out in order: the thread before anything in it, a card before its edits.
    let chain: Promise<void> = Promise.resolve();
    const write = (what: string, task: () => Promise<void>): Promise<void> => {
        chain = chain.then(task).catch((error: Error) => log.warn({ err: error }, `discord reply: ${what} failed`));
        return chain;
    };
    // Where replies go: the thread once it is open, else the room the route names. In a channel with no thread, the
    // first reply quotes the message it answers.
    let room = target.route.room;
    let quoteFirst = target.route.opens === undefined && target.route.thread === undefined && target.route.room === target.channelId;
    let opening: Promise<void> | undefined;
    const openThread = (): Promise<void> => {
        const opens = target.route.opens;
        if (opens === undefined) {
            if (target.route.thread !== undefined) {
                deps.joined(target.route.thread);
            }
            return Promise.resolve();
        }
        opening ??= write("opening a thread", async () => {
            try {
                room = await startThread(rest, opens.parentId, opens.messageId, opens.name);
                quoteFirst = false;
                deps.joined(room);
            } catch (error) {
                // A channel that refuses threads (no permission, a type without them) still gets its answer, quoted.
                log.warn({ err: error }, "discord reply: could not open a thread, answering in the channel");
                quoteFirst = true;
                return;
            }
            // In the thread, the asker sees it in their list and hears what is said there.
            await addThreadMember(rest, room, target.authorId).catch((error: Error) => log.warn({ err: error }, "discord reply: could not add the asker to the thread"));
        });
        return opening;
    };

    // "typing…" in whichever room replies go to, from the moment the message is heard until its turns end.
    const typingStartedAt = timing.now();
    const sayTyping = (): void => {
        // allow(silent-catch): "typing…" is a courtesy said every few seconds; a room that refuses it still gets its answer
        void typing(rest, room).catch(() => undefined);
    };
    sayTyping();
    const typingTimer = setInterval(() => {
        if (timing.now() - typingStartedAt > timing.typingMaxMs) {
            clearInterval(typingTimer);
            return;
        }
        sayTyping();
    }, timing.typingEveryMs);

    // Reactions on the message (and on any message steered into its turn): 👀 the moment it is heard, swapped as the
    // answer's state changes.
    const reactionsOn = new Map<string, { channelId: string; id: string; showing: string }>([
        [target.messageId, { channelId: target.channelId, id: target.messageId, showing: EMOJI.heard }],
    ]);
    void write("acknowledging the message", () => react(rest, target.channelId, target.messageId, EMOJI.heard));
    const showReaction = (emoji: string): void => {
        for (const message of reactionsOn.values()) {
            if (message.showing === emoji) {
                continue;
            }
            const previous = message.showing;
            message.showing = emoji;
            void write(`reacting ${emoji}`, async () => {
                await react(rest, message.channelId, message.id, emoji);
                // allow(silent-catch): the reaction it replaces may already be gone (taken off by hand); the new one stands either way
                await unreact(rest, message.channelId, message.id, previous).catch(() => undefined);
            });
        }
    };

    const outcomes: Outcome[] = [];
    const views = new Map<string, RunView>();

    const postText = async (text: string, mention: boolean): Promise<void> => {
        const chunks = chunkMessage(tablesToCode(text), DISCORD_MAX - (mention ? target.authorId.length + 5 : 0));
        for (const [index, chunk] of chunks.entries()) {
            const named = index === 0 && mention;
            const body: MessageBody = {
                content: named ? `<@${target.authorId}> ${chunk}` : chunk,
                allowed_mentions: named ? { parse: [], users: [target.authorId] } : NO_PINGS,
            };
            await postMessage(rest, room, quoteFirst ? { ...body, message_reference: { message_id: target.messageId, fail_if_not_exists: false } } : body);
            quoteFirst = false;
        }
    };

    // One automation's turn answering this message.
    const runView = (): RunView => {
        const progress: TurnProgressTracker = trackTurnProgress(timing.now);
        let card: string | undefined;
        let cardWanted = false;
        let lastEditAt = 0;
        let editTimer: ReturnType<typeof setTimeout> | undefined;
        let gateTimer: ReturnType<typeof setTimeout> | undefined;
        let refreshTimer: ReturnType<typeof setInterval> | undefined;
        let block = "";
        let headline: string | undefined;
        let posted = 0;
        let stoppedBy: string | undefined;
        // The conversation this turn runs in and the room it was registered under, for Stop and for steered messages.
        let registered: { readonly conversationId: string; readonly room: string } | undefined;
        const view = (): CardView => {
            let shown: CardView = { progress: progress.state(), now: timing.now(), detail: deps.detail === "quiet" ? "quiet" : "steps" };
            if (headline !== undefined) {
                shown = { ...shown, headline };
            }
            if (stoppedBy !== undefined) {
                shown = { ...shown, stoppedBy };
            }
            return shown;
        };
        const paint = (): void => {
            lastEditAt = timing.now();
            void write("drawing the status card", async () => {
                if (card === undefined) {
                    card = await postMessage(rest, room, renderCard(view()));
                    return;
                }
                await editMessage(rest, room, card, renderCard(view()));
            });
        };
        // The card appears (once the work outlasts a quick answer, or at once when it has to say why nothing runs), then
        // follows the work at most once per edit interval.
        const showCard = (): void => {
            if (deps.detail === "off" || cardWanted) {
                return;
            }
            cardWanted = true;
            void openThread();
            paint();
            refreshTimer = setInterval(() => {
                if (!progress.state().ended) {
                    paint();
                }
            }, timing.refreshEveryMs);
        };
        const repaint = (): void => {
            if (!cardWanted || editTimer !== undefined) {
                return;
            }
            const wait = Math.max(0, lastEditAt + timing.editEveryMs - timing.now());
            editTimer = setTimeout(() => {
                editTimer = undefined;
                paint();
            }, wait);
        };
        const say = (text: string, final: boolean): void => {
            const mention = final && timing.now() - (progress.state().openedAt ?? progress.state().startedAt) > timing.mentionAfterMs;
            posted += 1;
            void openThread();
            void write("posting the reply", () => postText(text, mention));
        };
        // A finished block of the reply: a short line before the agent acts goes on the card; anything else, and the
        // last block of the turn, is posted.
        const flush = (final: boolean): void => {
            const text = block.trim();
            block = "";
            if (text === "") {
                return;
            }
            if (!final && deps.detail !== "off" && isNarration(text)) {
                headline = text;
                repaint();
                return;
            }
            say(text, final);
        };
        const finish = (): void => {
            clearTimeout(gateTimer);
            clearTimeout(editTimer);
            clearInterval(refreshTimer);
            editTimer = undefined;
            const state = progress.state();
            // Nothing posted but narration: the last line said is the answer, unless the turn was cut short (stopped,
            // failed), when that line was only where it got to.
            if (posted === 0 && block.trim() === "" && headline !== undefined && state.failed === undefined && stoppedBy === undefined) {
                block = headline;
                headline = undefined;
            }
            flush(true);
            if (cardWanted) {
                paint();
            }
            if (registered !== undefined) {
                deps.registry.closed(registered.conversationId, registered.room);
            }
            const outcome = outcomeOf(state, stoppedBy);
            if (outcome !== undefined) {
                outcomes.push(outcome);
            }
        };
        const control: RunControl = {
            stopping: (by) => {
                stoppedBy = by;
                paint();
            },
            adopt: (message) => {
                if (!reactionsOn.has(message.id)) {
                    reactionsOn.set(message.id, { ...message, showing: EMOJI.heard });
                }
            },
        };
        const take = (frame: ListenerDispatchFrame): void => {
            const before = progress.state();
            progress.apply(frame);
            if (frame.opened !== undefined) {
                registered = { conversationId: frame.opened.conversationId, room: target.route.thread ?? room };
                deps.registry.opened(registered.conversationId, registered.room, control);
                if (before.queued !== undefined || before.held !== undefined) {
                    showReaction(EMOJI.heard);
                    repaint();
                } else {
                    gateTimer = setTimeout(showCard, timing.cardAfterMs);
                }
            }
            if (frame.held !== undefined) {
                showReaction(EMOJI.held);
                showCard();
            }
            if (frame.queued !== undefined) {
                showReaction(EMOJI.queued);
                showCard();
            }
            if (frame.delta !== undefined) {
                block += frame.delta;
            }
            if (frame.step !== undefined) {
                if (frame.step.status === "running") {
                    flush(false);
                }
                repaint();
            }
            if (frame.plan !== undefined || (frame.delta !== undefined && !before.writing)) {
                repaint();
            }
            if (frame.failed !== undefined) {
                void openThread();
                void write("posting the failure", () => postText(`⚠️ ${frame.failed}`, false));
            }
            if (frame.end === true) {
                finish();
            }
        };
        return { frame: take, ended: () => progress.state().ended };
    };

    // A message steered into a turn already running in its thread: that turn answers it, so it takes its reactions.
    const adopt = (): void => {
        const running = deps.registry.running(target.route.thread ?? room);
        if (running !== undefined) {
            running.adopt({ channelId: target.channelId, id: target.messageId });
            reactionsOn.delete(target.messageId);
            return;
        }
        outcomes.push("done");
    };

    return {
        frame: (frame) => {
            if (frame.steered === true) {
                adopt();
                return;
            }
            let view = views.get(frame.automationId);
            if (view === undefined) {
                view = runView();
                views.set(frame.automationId, view);
            }
            view.frame(frame);
        },
        settle: async () => {
            clearInterval(typingTimer);
            // A stream that broke before its turn said it ended leaves no card saying "Working" forever.
            for (const [automationId, view] of views) {
                if (!view.ended()) {
                    view.frame({ automationId, failed: LOST_NOTICE });
                    view.frame({ automationId, end: true });
                }
            }
            if (reactionsOn.size === 0) {
                await chain;
                return;
            }
            if (outcomes.length === 0) {
                // Nothing took the message: take back the 👀 that said someone would.
                for (const message of reactionsOn.values()) {
                    void write("taking back the acknowledgement", () => unreact(rest, message.channelId, message.id, message.showing));
                }
                await chain;
                return;
            }
            const final: Outcome = outcomes.includes("failed") ? "failed" : outcomes.includes("stopped") ? "stopped" : outcomes.includes("held") ? "held" : "done";
            showReaction(EMOJI[final]);
            await chain;
        },
    };
};
