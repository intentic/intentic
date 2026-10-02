import { t } from "@intentic/ui/i18n";
import { agentDisplayTitle, attentionReason, type AgentStanding } from "../../features/agents/fleet/agentStatus";
import { fleet } from "../../features/agents/fleet/useAgents-fleet";
import { heldWakes } from "../../features/agents/fleet/useAgents-registry";
import { activeSandboxId } from "../../features/sandbox/overview/activeSandbox";
import { otherBoxes } from "../../features/sandbox/live/fleetAcross";
import { clearDesktopNotices, type DesktopNotice, desktopNotices, postDesktopNotice, withdrawDesktopNotice } from "../../app/environments/desktopNotices";
import { CHIME_GAP_MS } from "./chimes";
import { noticeAsks, noticeFinished } from "./tabPreferences";
import type { NewsItems, TabFrame } from "./tabSignal";

// The tab's news as the desktop app's notifications (desktop-app notice.rs): the one way this window reaches a reader
// who is in another app, since no push reaches it. The same news the chimes ring for (browserTab.ts), for the same
// reader, and nothing else:
// - one notification per agent that needs the reader, and per turn somebody started that finished, while they are away;
// - a burst (a workflow's agents all finishing together) is one notification counting them, not a column of them;
// - the system's sound for the first one only, never again within the chimes' own gap, and none at all when a chime
//   rings for it (the reader chose that sound);
// - an ask answered elsewhere (the phone, another tab) is taken down, and everything is taken down the moment the reader
//   is back in the app, where the board says it all.
// Rejected (2026-10-02): a notification while the reader is in the app (the board and the tab already show it there),
// one for work starting, and one for an automation's or a subagent's turn finishing, which nobody is waiting on.

// Past this many at once, one notification counts them.
export const BURST = 3;

/** What one notification says, read off the fleet: an agent that needs the reader, or one whose turn finished. */
export interface NoticeSubject {
    readonly title: string;
    // The line under the title: what it needs, or that it finished.
    readonly line: string;
    // The sandbox it is in, when that is not the one in front of the reader.
    readonly elsewhere?: string;
    readonly path: string;
}

export interface NoticeChoice {
    readonly asks: boolean;
    readonly finished: boolean;
    // A chime rings for this news (browserTab.ts), so no notification makes a sound of its own.
    readonly chimed: boolean;
    // Whether the system's sound may play now, outside the gap since the last one.
    readonly sound: boolean;
}

const bodyOf = (subject: NoticeSubject): string => (subject.elsewhere === undefined ? subject.line : t(`shell.desktopSignal.elsewhere`, { line: subject.line, sandbox: subject.elsewhere }));

// The notifications for one reading's news, in the order they go up: what needs the reader first.
export const noticesFor = (
    items: NewsItems,
    describe: { readonly ask: (source: string, key: string) => NoticeSubject | undefined; readonly finish: (key: string) => NoticeSubject | undefined },
    choice: NoticeChoice,
): readonly DesktopNotice[] => {
    const notices: Omit<DesktopNotice, `silent`>[] = [];
    const group = (kind: DesktopNotice[`kind`], keyed: readonly (readonly [string, NoticeSubject])[], many: (count: number) => string): void => {
        if (keyed.length > BURST) {
            notices.push({ key: `${kind}:many`, kind, title: many(keyed.length), body: keyed.map(([, subject]) => subject.title).join(` · `), path: `/agents` });
            return;
        }
        for (const [key, subject] of keyed) {
            notices.push({ key, kind, title: subject.title, body: bodyOf(subject), path: subject.path });
        }
    };
    if (choice.asks) {
        const asked = items.asked.flatMap(({ source, key }) => {
            const subject = describe.ask(source, key);
            return subject === undefined ? [] : [[askKey(source, key), subject] as const];
        });
        group(`asks`, asked, (count) => t(`shell.desktopSignal.manyAsks`, { count }, count));
    }
    if (choice.finished) {
        const finished = items.finished.flatMap((key) => {
            const subject = describe.finish(key);
            return subject === undefined ? [] : [[`finished:${key}`, subject] as const];
        });
        group(`finished`, finished, (count) => t(`shell.desktopSignal.manyFinished`, { count }, count));
    }
    const sounds = choice.sound && !choice.chimed;
    return notices.map((notice, index) => ({ ...notice, silent: !sounds || index > 0 }));
};

// One ask's notification key: its source (a sandbox, or its held wakes) and the caller.
const askKey = (source: string, key: string): string => `asks:${source}/${key}`;

// The asks the page has a notification up for that the reading no longer holds: answered elsewhere, or let go. Only a
// source the reading still has can say so; one it dropped (a sandbox switched away from) vouches for nothing.
export const settledAsks = (posted: ReadonlySet<string>, after: TabFrame): readonly string[] =>
    [...after.asks].flatMap(([source, keys]) =>
        [...posted].filter((notice) => {
            const prefix = `asks:${source}/`;
            return notice.startsWith(prefix) && !keys.has(notice.slice(prefix.length));
        }),
    );

/* WHAT AN AGENT'S NOTIFICATION SAYS, read off the fleet as the board draws it. */

const HELD = `#held`;

const conversationPath = (sandbox: string, id: string): string => `/?${new URLSearchParams({ sandbox, conversation: id }).toString()}`;

// What the ask's line says: the reason the board's card gives (attentionReason), behind "Needs you".
const askLine = (agent: AgentStanding): string => {
    const reason = attentionReason(agent);
    return reason === undefined || reason === t(`agents.agentStatus.needsYou`) ? t(`shell.desktopSignal.needsYou`) : t(`shell.desktopSignal.needsYouFor`, { reason });
};

const describeAsk = (source: string, key: string): NoticeSubject | undefined => {
    const held = source.endsWith(HELD);
    const sandbox = held ? source.slice(0, -HELD.length) : source;
    const box = sandbox === activeSandboxId.value ? undefined : otherBoxes.value.find((entry) => entry.sandbox.id === sandbox);
    const elsewhere = box?.sandbox.name;
    if (held) {
        const wake = (box === undefined ? heldWakes.value : box.held).find((entry) => entry.id === key);
        if (wake === undefined) {
            return undefined;
        }
        return {
            title: t(`shell.desktopSignal.heldTitle`),
            line: wake.title ?? t(`shell.desktopSignal.heldLine`),
            elsewhere,
            path: `/needs?${new URLSearchParams({ sandbox }).toString()}`,
        };
    }
    const agent = (box === undefined ? fleet.value : box.agents).find((entry) => entry.id === key);
    return agent === undefined ? undefined : { title: agentDisplayTitle(agent), line: askLine(agent), elsewhere, path: conversationPath(sandbox, key) };
};

// A finished turn's frame key is `<sandbox>/<agent>`, and only the sandbox in front of the reader has its turns read.
const describeFinish = (key: string): NoticeSubject | undefined => {
    const at = key.indexOf(`/`);
    const sandbox = key.slice(0, at);
    const id = key.slice(at + 1);
    const agent = sandbox === activeSandboxId.value ? fleet.value.find((entry) => entry.id === id) : undefined;
    return agent === undefined ? undefined : { title: agentDisplayTitle(agent), line: t(`shell.desktopSignal.finished`), path: conversationPath(sandbox, id) };
};

/* WHAT IS UP, so what is settled can be taken down and the reader's return clears only what there is. */

// The notifications this page asked the app for, by key: one set per window, whichever sandbox each is about.
const posted = new Set<string>();
// When a notification of this page's last made a sound.
let soundedAt = Number.NEGATIVE_INFINITY;
// Whether this page has cleared once, which also clears what a page before it left up.
let clearedOnce = false;

/** Tells the desktop app this reading's news, for a reader who is away. */
export const tellDesktop = (items: NewsItems, chimed: boolean, now: number = Date.now()): void => {
    if (!desktopNotices()) {
        return;
    }
    const notices = noticesFor(
        items,
        { ask: describeAsk, finish: describeFinish },
        { asks: noticeAsks.value, finished: noticeFinished.value, chimed, sound: now - soundedAt >= CHIME_GAP_MS || now < soundedAt },
    );
    for (const notice of notices) {
        if (!notice.silent) {
            soundedAt = now;
        }
        posted.add(notice.key);
        postDesktopNotice(notice);
    }
};

/** Takes down the notifications for asks this reading no longer holds. */
export const settleDesktop = (after: TabFrame): void => {
    for (const key of settledAsks(posted, after)) {
        posted.delete(key);
        withdrawDesktopNotice(key);
    }
};

/** The reader is back: everything this page put up goes. The first time, whatever a page before it left up goes too. */
export const readerBack = (): void => {
    if (posted.size === 0 && clearedOnce) {
        return;
    }
    clearedOnce = true;
    posted.clear();
    clearDesktopNotices();
};

/** Settings' "Send a test": one notification now, here or not, taken down with the rest once the reader is back. */
export const sendTestNotice = (): void => {
    const key = `test`;
    posted.add(key);
    postDesktopNotice({ key, kind: `asks`, title: t(`shell.desktopSignal.testTitle`), body: t(`shell.desktopSignal.testLine`), silent: false });
};
