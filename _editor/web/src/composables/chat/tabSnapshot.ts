import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import type { Conversation } from "./conversation";
import type { PickUp, PickUpReason } from "./pickUp";
import type { SessionRef } from "./turnRequest";
import { forgetWindowState, readWindowState, writeWindowState } from "../windowStore";

/* Where a sandbox's open chat tabs live between page loads: session/provider identity, title, and the composer
 * draft (text + done-upload metadata), as one JSON blob per sandbox, this window's own, seeded by the last
 * window's (windowStore holds the two-store mechanics and why). Transcript CONTENT is not in here, it is
 * mirrored to IndexedDB instead (see transcriptCache), so a restored tab paints from disk at once and useChat's
 * rehydration watch then reconciles it with the daemon. */

// One tab, as persisted. Everything optional is a value the tab can genuinely lack; nothing here is a
// compatibility shim, so a blob that doesn't fit is dropped rather than migrated.
export interface StoredTab {
    // The stable daemon-side conversation identity (fleet registry + worktree key), and the tab's identity in
    // the strip. An entry without one names nothing and is dropped.
    readonly conversationId: string;
    // Whether the conversation runs in its own isolated worktree rather than on the shared /work tree.
    readonly isolated: boolean;
    // Whether the fleet has ever registered this conversation (Conversation.registered). Persisted so a reload
    // doesn't hand every open agent tab back to the board as a fresh draft card while the first roster frame
    // is still in flight, and never at all for one whose agent has since been archived.
    readonly registered: boolean;
    // The tab's turn selection; the session's provider may differ while a switch is picked but not yet sent.
    readonly provider?: AgentProvider;
    // The tab's harness selection (native vs the Claude Code loop); absent ⇒ the current default on restore.
    readonly harness?: AgentHarness;
    // Which of the provider's accounts this tab's next turn runs on. Per TAB, not merely per provider: the
    // remembered pick seeds NEW conversations, and applying it to the open ones would quietly move a chat off
    // the account it has been running on because another tab was switched. Absent ⇒ the remembered pick.
    readonly account?: string;
    // The tab's model / reasoning effort / extended-thinking picks, persisted for the SAME reason `account` is:
    // the remembered picks (turnDefaults) seed a NEW conversation, and re-seeding the open ones from them on a
    // reload is how a chat that ran on Sonnet came back claiming whatever model another tab was last switched
    // to. Absent ⇒ the remembered pick, which is what a tab persisted before this was stored was showing.
    readonly model?: string;
    readonly effort?: string;
    readonly thinking?: boolean;
    // The fast-speed pick, persisted per TAB for the same reason and NOT remembered globally: it is a property
    // of this chat, and a reload should show the same chat back, but a new chat starts from off (turnDefaults
    // deliberately doesn't carry it; see Conversation.fast).
    readonly fast?: boolean;
    // Whether this chat continues itself when a turn stops short (Conversation.autoContinue). Persisted per TAB
    // like `fast`, and for a stronger reason than the picks above: it is armed precisely for the stops nobody is
    // sitting there for, so a reload dropping it would silently end the unattended run it was turned on for.
    readonly autoContinue?: boolean;
    /* THE STOPPED TURN ITSELF (Conversation.pickUp), which used to die with the tab and take the offer with it.
     *
     * Persisting it matters most for the ending that waits longest: a spent allowance resets hours out, reliably
     * outliving the window that hit it, so an offer held only in memory was guaranteed to be gone by the time it
     * became pressable. The daemon holds the session either way; what a reload lost was the client's knowledge
     * that there was anything to pick up. Absent on every chat whose last turn finished. */
    readonly pickUp?: PickUp;
    // The automatic-tier veto (Conversation.tierHold), per TAB like `fast` and for its reason: a property of
    // this chat, never a remembered default. The daemon also persists it per conversation, so this only bridges
    // the reload gap for a chat that has not sent a turn since flipping it.
    readonly tierHold?: boolean;
    // The complexity judge's last verdict here (Conversation.lastTier), not a pick at all: it is the one input
    // the composer's pre-send preview cannot re-derive from a draft, and a reload that dropped it would judge
    // the first follow-up as if the conversation had no history.
    readonly tier?: "fast" | "standard";
    // The persona this tab acts as, by id. Per TAB and nowhere else: it is never a remembered default (a
    // narrowing must not follow the user into their next chat), so this store is the only thing standing
    // between a picked persona and a page reload. Absent ⇒ the ordinary chat, every account reachable.
    readonly actsAs?: string;
    /* The session and the WHOLE of what it is bound to (SessionRef: the runtime and the credential that minted
     * it), none of which is always the tab's current pick. A mid-chat switch takes effect at the next send, and
     * until then the two differ on purpose — that difference is what retires the session then. Storing the
     * session's own trio keeps a reload from either forging the match or faking the mismatch, and it decides
     * real money: a lie either way costs a resumable session and re-reads the whole transcript on a cold cache.
     *
     * A session with no `account` is one no stored account minted (the container's env token, a translator
     * subscription), which is a fact about it, not a gap to fill in from the tab. */
    readonly session?: SessionRef;
    /* Where this tab was cut from, while it is a fork whose first turn the daemon has not accepted yet, until
     * that send, this linkage exists nowhere but the client (Conversation.pendingForkOf). Persisted because the
     * gap between the cut and the send is exactly when a tab can be rebuilt from this snapshot (a reload, the
     * popped window hydrating the strip): a rebuilt fork that lost it sent an ordinary first turn, the daemon
     * opened an empty record with nothing to seed the session from, and a chat that looked continued answered
     * from nothing. Absent on every ordinary tab, and on a fork from its acked first turn onward. */
    readonly forkOf?: { conversationId: string; keep: number; files: "then" | "now" };
    readonly title?: string;
    readonly draft: string;
    readonly attachments: { name: string; path: string }[];
    // Messages submitted while a turn ran that hadn't reached the agent yet, user-written text, so a refresh
    // must not swallow them. They restore as queued (not as draft, which would collide with the real draft)
    // and go out when the tab's turn settles or with the user's next send. The editor-context chip on one is
    // deliberately dropped: it points at a selection this window no longer has.
    readonly queued: { text: string; attachments: { name: string; path: string }[] }[];
}

/* One live conversation, as its persisted shape. StoredTab is the ONE portable description of a tab, and this
 * is the one place a Conversation is folded into it. Two readers with different lifetimes share it: the
 * tab-snapshot watch (useChat), which persists every open tab on every change, and the summons channel
 * (summon.ts), which sends a tab to the app's OTHER windows so a chat summoned anywhere is on screen
 * everywhere. JSON.stringify drops the undefined keys, matching StoredTab's optional fields. */
export const snapshotTab = (conversation: Conversation): StoredTab => ({
    conversationId: conversation.conversationId,
    isolated: conversation.isolated.value,
    registered: conversation.registered.value,
    provider: conversation.provider.value,
    account: conversation.account.value,
    model: conversation.model.value,
    effort: conversation.effortPick.value,
    actsAs: conversation.actsAs.value,
    thinking: conversation.thinking.value,
    fast: conversation.fast.value,
    autoContinue: conversation.autoContinue.value,
    pickUp: conversation.pickUp.value,
    tierHold: conversation.tierHold.value,
    tier: conversation.lastTier.value,
    harness: conversation.harness.value,
    // The session ref verbatim (SessionRef IS this shape), never rebuilt field by field from the conversation's
    // picks: the two are the same object exactly until someone switches something, which is the one moment this
    // has to be right.
    session: conversation.session.value,
    forkOf: conversation.pendingForkOf.value,
    title: conversation.title.value ?? undefined,
    draft: conversation.draft.value,
    attachments: conversation.attachments.value.filter((file) => file.status === `done`).map((file) => ({ name: file.name, path: file.path })),
    queued: conversation.queued.value.map((message) => ({
        text: message.text,
        attachments: message.attachments.map((file) => ({ name: file.name, path: file.path })),
    })),
});

// A sandbox's whole strip: the open tabs, which one is focused, and which of them are on screen at once (the
// panes, in their column order). Coherent by construction, `active` always names one of `tabs`, every pane
// names one too, `active` is always among the panes, and no conversation appears twice.
export interface TabSnapshot {
    readonly active: string;
    readonly panes: readonly string[];
    readonly tabs: readonly StoredTab[];
}

const snapshotKey = (sandboxId: string): string => `intentic.chatTabs.${sandboxId}`;

// Providers are an open string vocabulary (native ids + installed ACP agent ids), a stored provider is valid
// when non-empty; a since-removed ACP id degrades at send time (the daemon's unknown-provider error frame).
const validProvider = (value: unknown): value is AgentProvider => typeof value === `string` && value !== ``;

// The persisted shape of one attachment (upload metadata only, previewUrl/controller are client-session
// objects), read back defensively from the tab snapshot's draft and queued entries alike.
const readAttachments = (raw: unknown): { name: string; path: string }[] =>
    (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
        .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
        .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string }));

// One optional text field, an account pin, a model id, an effort tier, under the key its owner carries it in.
// Spreadable, so a blob with nothing (or nonsense) where a value should be reads back as the absence the
// restore already falls back from.
const readText = <K extends string>(key: K, raw: unknown): { [P in K]?: string } =>
    typeof raw === `string` && raw !== `` ? ({ [key]: raw } as { [P in K]?: string }) : {};

const PICK_UP_REASONS: readonly PickUpReason[] = [`stopped`, `limit`, `outage`];

/* The stopped turn, read back. `readyAt` survives because it is the whole value of persisting this: an
 * allowance reset is an absolute instant and stays true across a reload.
 *
 * `automatic` deliberately does NOT. It means "something outside this window is already bringing the turn
 * back", and the thing watching for that arrival was this window's own probe, which the reload ended. Restoring
 * it would count down to an instant already past and promise an arrival nobody is waiting for; dropped, the tab
 * comes back saying what is still true, that the turn is here and one press picks it up. */
const readPickUp = (raw: unknown): { pickUp?: PickUp } => {
    const entry = typeof raw === `object` && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const reason = PICK_UP_REASONS.find((candidate) => candidate === entry?.[`reason`]);
    if (reason === undefined) {
        return {};
    }
    const readyAt = entry?.[`readyAt`];
    return { pickUp: { reason, ...(typeof readyAt === `number` && Number.isFinite(readyAt) ? { readyAt } : {}) } };
};

/* The session, read back WHOLE or not at all: what it is bound to is what it is read for, so an entry missing
 * its provider or its runtime names a session nothing can decide with, and completing it from the tab's own
 * picks would answer "does my next message resume this?" with the tab's plans for the NEXT one. `account` is
 * the exception and not a gap: a session no stored account minted (the container's env token, a translator
 * subscription) genuinely has none. */
const readSession = (raw: unknown): { session?: SessionRef } => {
    const session = typeof raw === `object` && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (session === undefined || typeof session[`id`] !== `string` || !validProvider(session[`provider`])) {
        return {};
    }
    if (session[`harness`] !== `claude-code` && session[`harness`] !== `native`) {
        return {};
    }
    const account = session[`account`];
    return {
        session: {
            id: session[`id`],
            provider: session[`provider`],
            harness: session[`harness`],
            account: typeof account === `string` && account !== `` ? account : undefined,
        },
    };
};

// One entry, or undefined when it carries no usable identity or draft. Skipped rather than fatal: a single
// unreadable tab must not cost the user every other chat they had open.
const readTab = (raw: Record<string, unknown>): StoredTab | undefined => {
    if (typeof raw[`conversationId`] !== `string` || raw[`conversationId`] === `` || typeof raw[`draft`] !== `string`) {
        return undefined;
    }
    // The fork linkage, read back whole or not at all: a partial one would make the first send name a source
    // the daemon then copies the wrong prefix of, which is worse than the fresh start losing it means.
    const fork = raw[`forkOf`] as Record<string, unknown> | null | undefined;
    const validForkOf =
        typeof fork === `object` &&
        fork !== null &&
        typeof fork[`conversationId`] === `string` &&
        fork[`conversationId`] !== `` &&
        typeof fork[`keep`] === `number` &&
        Number.isInteger(fork[`keep`]) &&
        (fork[`keep`] as number) >= 0 &&
        (fork[`files`] === `then` || fork[`files`] === `now`)
            ? { conversationId: fork[`conversationId`] as string, keep: fork[`keep`] as number, files: fork[`files`] as `then` | `now` }
            : undefined;
    return {
        conversationId: raw[`conversationId`],
        // A tab that names no tree runs in its own worktree, the default a fresh one gets.
        isolated: raw[`isolated`] !== false,
        // ...and one that doesn't say the fleet knows it is a draft until a roster frame says otherwise.
        registered: raw[`registered`] === true,
        draft: raw[`draft`],
        attachments: readAttachments(raw[`attachments`]),
        queued: (Array.isArray(raw[`queued`]) ? (raw[`queued`] as Record<string, unknown>[]) : [])
            .filter((entry) => typeof entry[`text`] === `string`)
            .map((entry) => ({ text: entry[`text`] as string, attachments: readAttachments(entry[`attachments`]) })),
        ...(validProvider(raw[`provider`]) ? { provider: raw[`provider`] } : {}),
        ...readText(`account`, raw[`account`]),
        ...readText(`model`, raw[`model`]),
        ...readText(`effort`, raw[`effort`]),
        ...readText(`actsAs`, raw[`actsAs`]),
        ...(typeof raw[`thinking`] === `boolean` ? { thinking: raw[`thinking`] } : {}),
        ...(typeof raw[`fast`] === `boolean` ? { fast: raw[`fast`] } : {}),
        ...(typeof raw[`autoContinue`] === `boolean` ? { autoContinue: raw[`autoContinue`] } : {}),
        ...readPickUp(raw[`pickUp`]),
        ...(typeof raw[`tierHold`] === `boolean` ? { tierHold: raw[`tierHold`] } : {}),
        ...(raw[`tier`] === `fast` || raw[`tier`] === `standard` ? { tier: raw[`tier`] as `fast` | `standard` } : {}),
        ...(raw[`harness`] === `claude-code` || raw[`harness`] === `native` ? { harness: raw[`harness`] as AgentHarness } : {}),
        ...readSession(raw[`session`]),
        ...(validForkOf !== undefined ? { forkOf: validForkOf } : {}),
        ...(typeof raw[`title`] === `string` ? { title: raw[`title`] } : {}),
    };
};

// Parse one stored blob into a coherent snapshot: readable tabs only, each conversation once (a duplicate id
// would render as two tabs sharing a key, which is how a strip ends up with the wrong name on the wrong tab
// and a × that removes neither), and a focus that names one of them.
const parse = (raw: string): TabSnapshot | undefined => {
    let stored: { active?: unknown; panes?: unknown; tabs?: unknown };
    try {
        stored = JSON.parse(raw) as { active?: unknown; panes?: unknown; tabs?: unknown };
    } catch {
        return undefined;
    }
    if (!Array.isArray(stored.tabs)) {
        return undefined;
    }
    const seen = new Set<string>();
    const tabs: StoredTab[] = [];
    for (const entry of stored.tabs as Record<string, unknown>[]) {
        const tab = readTab(entry);
        if (tab !== undefined && !seen.has(tab.conversationId)) {
            seen.add(tab.conversationId);
            tabs.push(tab);
        }
    }
    const first = tabs[0];
    if (first === undefined) {
        return undefined;
    }
    const active = typeof stored.active === `string` && seen.has(stored.active) ? stored.active : first.conversationId;
    // The panes, in their stored column order, keeping only those that still name a readable tab. A window
    // that named none, the ordinary single-pane panel, which has no layout to record, comes back showing the
    // focused chat alone, which is what an absent pane set MEANS rather than something to patch up.
    const panes = (Array.isArray(stored.panes) ? (stored.panes as unknown[]) : []).filter(
        (id): id is string => typeof id === `string` && seen.has(id),
    );
    return { active, panes: panes.includes(active) ? panes : [...panes, active], tabs };
};

// This window's tabs for a sandbox, else the last window's (the seed) when this one has never opened it.
export const readTabSnapshot = (sandboxId: string | undefined): TabSnapshot | undefined =>
    sandboxId === undefined ? undefined : readWindowState(snapshotKey(sandboxId), parse);

// Persist this window's strip. Takes the serialized snapshot because the store watches that string: it is what
// makes "any field of any tab changed" a single cheap comparison, so re-serializing here would only repeat it.
export const writeTabSnapshot = (sandboxId: string, json: string): void => {
    writeWindowState(snapshotKey(sandboxId), json);
};

// …and stop claiming to know this sandbox's strip, for as long as the chat is drawn by another window. The next
// read falls through to the seed, which is that window's, so taking the panel back picks its tabs up where they
// were left rather than where this window last saw them (windowStore.forgetWindowState has the whole argument).
export const forgetTabSnapshot = (sandboxId: string | undefined): void => {
    if (sandboxId !== undefined) {
        forgetWindowState(snapshotKey(sandboxId));
    }
};
