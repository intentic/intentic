import type { ListenerDispatchFrame } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { chunkMessage } from "./chunks.js";
import type { Logger } from "./log.js";
import { trackTurnProgress, type TurnProgress, type TurnProgressTracker } from "./progress.js";
import type { CardView, ProgressDetail } from "./status-card.js";

// One addressed message's answer in a team chat, from the moment it is heard to the moment its turn ends, the same on
// every platform: a mark on the message the moment it is heard and "typing…" while turns run; a status card that
// appears once the work outlasts a quick answer and is edited in place as the agent works; the reply posted as
// ordinary messages, cut at code-aware seams, with a short line of narration going on the card instead; and a mark that
// says how it ended (done, failed, stopped, waiting for approval). A message steered into a turn already running takes
// that turn's marks, and a stream that breaks before its turn ended says so instead of leaving a card working forever.
// One view per automation that answers the message, sharing its marks and its thread.
//
// What a platform does differently (where a reply goes, how a card is drawn, what a mark is) is its ChatSurface.

// How a message stands, as the mark on it says: heard, then how its answer ended or why it waits.
export type ReplyMark = "heard" | "done" | "failed" | "held" | "queued" | "stopped";

// A message by the room it was posted in and its own id.
export interface ChatMessageRef {
    readonly channelId: string;
    readonly id: string;
}

// The clock and cadences a reply runs on; tests shrink them.
export interface ReplyTiming {
    // How long a turn may work before its card appears: a quick answer posts none.
    readonly cardAfterMs: number;
    // The least time between two edits of one card (chats limit edits per channel).
    readonly editEveryMs: number;
    // How often a card's elapsed time is refreshed while nothing else changes on it.
    readonly refreshEveryMs: number;
    // How often "typing…" is said again, for a surface that does not say how long its own lasts.
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
// into it is answered by it, so it takes that message's marks too.
export interface RunControl {
    readonly stopping: (by: string) => void;
    readonly adopt: (message: ChatMessageRef) => void;
}

// The turns running now, by conversation (for Stop) and by the place the conversation lives (for a steered message).
export interface ReplyRegistry {
    readonly opened: (conversationId: string, place: string, run: RunControl) => void;
    readonly closed: (conversationId: string, place: string) => void;
    readonly running: (place: string) => RunControl | undefined;
}

// One platform's half of a reply: where its messages go and how they look. Every call may throw; a failed one is
// logged and the reply carries on.
export interface ChatSurface<TCard> {
    // The longest message the platform takes; a longer reply is cut into several.
    readonly maxChars: number;
    // How many characters naming the asker costs on the first message of a late answer.
    readonly mentionCost?: number;
    // The reply as this platform should get it, before it is cut (tables redrawn as code where they would not render).
    readonly format?: (text: string) => string;
    // Runs once before anything is posted in reply: open the thread replies go to, when one has to be opened.
    readonly prepare?: () => Promise<void>;
    // One message of the reply; `mention` names the asker in it.
    readonly post: (text: string, options: { readonly mention: boolean }) => Promise<void>;
    readonly postCard: (view: CardView) => Promise<TCard>;
    readonly editCard: (card: TCard, view: CardView) => Promise<void>;
    // Puts a mark on a message; `unmark` takes one off.
    readonly mark: (message: ChatMessageRef, mark: ReplyMark) => Promise<void>;
    readonly unmark: (message: ChatMessageRef, mark: ReplyMark) => Promise<void>;
    // "typing…" while turns run: said at once and every `everyMs`, and `clear`ed once they ended, for a platform whose
    // indicator outlives the answer.
    readonly typing?: {
        readonly say: () => Promise<void>;
        readonly everyMs?: number;
        readonly clear?: () => Promise<void>;
    };
}

export interface ChatReplyDeps<TCard> {
    // The platform, as log lines name it.
    readonly provider: string;
    readonly surface: ChatSurface<TCard>;
    readonly log: Logger;
    readonly detail: ProgressDetail;
    readonly registry: ReplyRegistry;
    readonly timing?: ReplyTiming;
}

export interface ChatReplyTarget {
    // The message being answered.
    readonly message: ChatMessageRef;
    // Where its conversation lives (its thread, else its room): a message steered into a running turn finds it by this.
    readonly place: string;
    // Runs once, when an automation first takes the message (a turn opens for it, or it is held or queued).
    readonly onTaken?: () => void;
}

export interface ChatReply {
    readonly frame: (frame: ListenerDispatchFrame) => void;
    // The dispatch is over (every turn ended, or nothing took the message): settle the marks and stop typing.
    readonly settle: () => Promise<void>;
}

// A short line the agent says before it acts, which reads better on the card than as a message of its own.
const NARRATION_MAX = 280;
export const isNarration = (text: string): boolean => text.length <= NARRATION_MAX && !text.includes("```") && text.split("\n").length <= 2;

// What a chat is told when the sandbox stopped streaming a turn before it ended (a restart, a dropped connection).
export const LOST_NOTICE = "I lost the connection to the sandbox before this finished; open the conversation in Intentic to see how it ended.";

// One automation's turn answering the message: the frames it is handed, and whether its turn has said it ended.
interface RunView {
    readonly frame: (frame: ListenerDispatchFrame) => void;
    readonly ended: () => boolean;
}

// How a run ended, for the message's marks.
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

export const createChatReply = <TCard>(deps: ChatReplyDeps<TCard>, target: ChatReplyTarget): ChatReply => {
    const timing = deps.timing ?? REPLY_TIMING;
    const { surface, log, provider } = deps;
    // Every write for this message goes out in order: the thread before anything in it, a card before its edits.
    let chain: Promise<void> = Promise.resolve();
    const write = (what: string, task: () => Promise<void>): Promise<void> => {
        chain = chain.then(task).catch((error: Error) => log.warn({ err: error }, `${provider} reply: ${what} failed`));
        return chain;
    };
    let preparing: Promise<void> | undefined;
    const prepare = (): Promise<void> => {
        const opens = surface.prepare;
        if (opens === undefined) {
            return Promise.resolve();
        }
        preparing ??= write("opening a thread", opens);
        return preparing;
    };
    let taken = false;
    const take = (): void => {
        if (!taken) {
            taken = true;
            target.onTaken?.();
        }
    };

    // "typing…" from the moment the message is heard until its turns end, capped so a stalled turn cannot leak it.
    const typingStartedAt = timing.now();
    const sayTyping = (): void => {
        // allow(silent-catch): "typing…" is a courtesy said every few seconds; a room that refuses it still gets its answer
        void surface.typing?.say().catch(() => undefined);
    };
    sayTyping();
    const typingTimer =
        surface.typing === undefined
            ? undefined
            : setInterval(() => {
                  if (timing.now() - typingStartedAt > timing.typingMaxMs) {
                      clearInterval(typingTimer);
                      return;
                  }
                  sayTyping();
              }, surface.typing.everyMs ?? timing.typingEveryMs);

    // Marks on the message (and on any message steered into its turn): heard the moment it is, swapped as the answer's
    // state changes.
    const marked = new Map<string, ChatMessageRef & { showing: ReplyMark }>([[target.message.id, { ...target.message, showing: "heard" }]]);
    void write("acknowledging the message", () => surface.mark(target.message, "heard"));
    const showMark = (mark: ReplyMark): void => {
        for (const message of marked.values()) {
            if (message.showing === mark) {
                continue;
            }
            const previous = message.showing;
            message.showing = mark;
            const ref = { channelId: message.channelId, id: message.id };
            void write(`marking ${mark}`, async () => {
                await surface.mark(ref, mark);
                // allow(silent-catch): the mark it replaces may already be gone (taken off by hand); the new one stands either way
                await surface.unmark(ref, previous).catch(() => undefined);
            });
        }
    };

    const outcomes: Outcome[] = [];
    const views = new Map<string, RunView>();

    const postText = async (text: string, mention: boolean): Promise<void> => {
        const formatted = surface.format === undefined ? text : surface.format(text);
        const chunks = chunkMessage(formatted, surface.maxChars - (mention ? (surface.mentionCost ?? 0) : 0));
        for (const [index, chunk] of chunks.entries()) {
            await surface.post(chunk, { mention: index === 0 && mention });
        }
    };

    // One automation's turn answering this message.
    const runView = (): RunView => {
        const progress: TurnProgressTracker = trackTurnProgress(timing.now);
        let card: TCard | undefined;
        let cardWanted = false;
        let lastEditAt = 0;
        let editTimer: ReturnType<typeof setTimeout> | undefined;
        let gateTimer: ReturnType<typeof setTimeout> | undefined;
        let refreshTimer: ReturnType<typeof setInterval> | undefined;
        let block = "";
        let headline: string | undefined;
        let posted = 0;
        let stoppedBy: string | undefined;
        // The conversation this turn runs in, registered for Stop and for steered messages.
        let registered: string | undefined;
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
                    card = await surface.postCard(view());
                    return;
                }
                await surface.editCard(card, view());
            });
        };
        // The card appears (once the work outlasts a quick answer, or at once when it has to say why nothing runs), then
        // follows the work at most once per edit interval.
        const showCard = (): void => {
            if (deps.detail === "off" || cardWanted) {
                return;
            }
            cardWanted = true;
            void prepare();
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
            void prepare();
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
                deps.registry.closed(registered, target.place);
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
                if (!marked.has(message.id)) {
                    marked.set(message.id, { ...message, showing: "heard" });
                }
            },
        };
        const apply = (frame: ListenerDispatchFrame): void => {
            const before = progress.state();
            progress.apply(frame);
            if (frame.opened !== undefined) {
                take();
                registered = frame.opened.conversationId;
                deps.registry.opened(registered, target.place, control);
                if (before.queued !== undefined || before.held !== undefined) {
                    showMark("heard");
                    repaint();
                } else {
                    gateTimer = setTimeout(showCard, timing.cardAfterMs);
                }
            }
            if (frame.held !== undefined) {
                take();
                showMark("held");
                showCard();
            }
            if (frame.queued !== undefined) {
                take();
                showMark("queued");
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
                void prepare();
                void write("posting the failure", () => postText(`⚠️ ${frame.failed}`, false));
            }
            if (frame.end === true) {
                finish();
            }
        };
        return { frame: apply, ended: () => progress.state().ended };
    };

    // A message steered into a turn already running where its conversation lives: that turn answers it, so it takes the
    // message's marks.
    const adopt = (): void => {
        const running = deps.registry.running(target.place);
        if (running !== undefined) {
            running.adopt(target.message);
            marked.delete(target.message.id);
            return;
        }
        outcomes.push("done");
    };

    return {
        frame: (frame) => {
            if (frame.steered === true) {
                take();
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
            const clear = surface.typing?.clear;
            if (clear !== undefined) {
                void write("clearing typing", clear);
            }
            if (marked.size === 0) {
                await chain;
                return;
            }
            if (outcomes.length === 0) {
                // Nothing took the message: take back the mark that said someone would.
                for (const message of marked.values()) {
                    const ref = { channelId: message.channelId, id: message.id };
                    void write("taking back the acknowledgement", () => surface.unmark(ref, message.showing));
                }
                await chain;
                return;
            }
            const final: Outcome = outcomes.includes("failed") ? "failed" : outcomes.includes("stopped") ? "stopped" : outcomes.includes("held") ? "held" : "done";
            showMark(final);
            await chain;
        },
    };
};
