import type { PresenceUser } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { sandboxRequest } from "./sandboxClient";
import { useAuth } from "./useAuth";

/* Live presence: who else is connected to the active sandbox and what they're looking at. Module-level
 * singleton with two halves. The ROSTER is fed by useSandboxLiveness from the daemon's /events presence
 * frames (full snapshots — last frame wins, nothing to reconcile). The REPORTER pushes this tab's own
 * activity (view / chat session / open file / idle) to the daemon, debounced and fire-and-forget; the
 * triggers live in WorkspaceShell (route, chat, visibility) and Workspace (open file) — presence only exists
 * while the shell holds the liveness stream open, so shell-scoped watches match its lifetime exactly. */

const { user } = useAuth();

// --- Roster (inbound) ---------------------------------------------------------------------------

const users = ref<readonly PresenceUser[]>([]);

// One OTHER member of the sandbox, aggregated across their open tabs.
export interface PresenceMember {
    readonly email: string;
    readonly name?: string;
    readonly picture?: string;
    // Idle only when EVERY tab is hidden — one visible tab means they're here.
    readonly idle: boolean;
    readonly tabs: readonly PresenceUser[];
}

// Everyone but me, one entry per member: active members first, alphabetical within, so the rail stack stays
// stable while the roster churns.
export const presenceOthers = computed<readonly PresenceMember[]>(() => {
    const self = user.value?.email.toLowerCase();
    const byEmail = new Map<string, PresenceUser[]>();
    for (const entry of users.value) {
        if (entry.email.toLowerCase() === self) {
            continue;
        }
        const group = byEmail.get(entry.email);
        if (group === undefined) {
            byEmail.set(entry.email, [entry]);
        } else {
            group.push(entry);
        }
    }
    const members: PresenceMember[] = [];
    for (const tabs of byEmail.values()) {
        const first = tabs[0]!;
        members.push({
            email: first.email,
            ...(first.name !== undefined ? { name: first.name } : {}),
            ...(first.picture !== undefined ? { picture: first.picture } : {}),
            idle: tabs.every((tab) => tab.idle),
            tabs,
        });
    }
    return members.toSorted((a, b) => Number(a.idle) - Number(b.idle) || a.email.localeCompare(b.email));
});

export const viewersOfPath = (path: string): readonly PresenceMember[] =>
    presenceOthers.value.filter((member) => member.tabs.some((tab) => tab.path === path));

export const viewersOfSession = (sessionId: string): readonly PresenceMember[] =>
    presenceOthers.value.filter((member) => member.tabs.some((tab) => tab.sessionId === sessionId));

// What a member is doing, for tooltips — from their most specific tab, visible tabs first.
export const presenceActivity = (member: PresenceMember): string => {
    const tabs = member.tabs.toSorted((a, b) => Number(a.idle) - Number(b.idle));
    const tab = tabs.find((t) => t.path !== undefined) ?? tabs.find((t) => t.sessionId !== undefined) ?? tabs.find((t) => t.view !== undefined);
    if (tab?.path !== undefined) {
        return `Viewing ${tab.path.split(`/`).pop()}`;
    }
    if (tab?.sessionId !== undefined) {
        return `In a chat session`;
    }
    if (tab?.view !== undefined) {
        return `Viewing ${tab.view}`;
    }
    return `Online`;
};

// Deterministic per-member accent (initials background / ring): the email hashes into one of 8 fixed hues,
// so a member keeps their color across sessions and browsers with no assignment state.
const HUES = [210, 350, 160, 40, 280, 20, 130, 320];
export const presenceHue = (email: string): number => {
    let hash = 0;
    for (const char of email) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return HUES[Math.abs(hash) % HUES.length]!;
};

// Two initials for the avatar fallback (name's word boundaries, else the email's first letters).
export const presenceInitials = (member: PresenceMember): string => {
    const source = member.name ?? member.email;
    const words = source.split(/[\s._@-]+/).filter((word) => word !== ``);
    if (words.length >= 2) {
        return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
    }
    return source.slice(0, 2).toUpperCase();
};

export const resetPresence = (): void => {
    users.value = [];
};

// --- Reporter (outbound) ------------------------------------------------------------------------

const DEBOUNCE_MS = 300;

// This tab's CURRENT /events connection id (set by the liveness loop per attempt) and its activity state.
let clientId: string | undefined;
const report: { idle: boolean; view?: string; sessionId?: string; path?: string } = { idle: false };
let lastSent: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

// One send fires DEBOUNCE_MS after the FIRST change of a window (not reset per change), reading the state at
// fire time — a navigation that flips view + file + session coalesces into one report with bounded latency.
// Fire-and-forget: a lost/rejected report self-heals on the next change or the reconnect's re-send.
const send = (): void => {
    timer ??= setTimeout(() => {
        timer = undefined;
        if (clientId === undefined) {
            return;
        }
        const body = JSON.stringify({ clientId, ...report });
        if (body === lastSent) {
            return;
        }
        lastSent = body;
        void sandboxRequest(`/system/presence`, { method: `POST`, headers: { "content-type": `application/json` }, body }).catch(() => undefined);
    }, DEBOUNCE_MS);
};

export const reportView = (view: string | undefined): void => {
    report.view = view;
    send();
};

export const reportSessionId = (sessionId: string | undefined): void => {
    report.sessionId = sessionId;
    send();
};

export const reportOpenPath = (path: string | undefined): void => {
    report.path = path;
    send();
};

export const reportIdle = (idle: boolean): void => {
    report.idle = idle;
    send();
};

// Called by the liveness loop right after each successful /events open, with that CONNECTION's fresh id: the
// daemon just registered a blank entry for it, so re-announce the current activity unconditionally.
export const presenceStreamOpened = (id: string): void => {
    clientId = id;
    lastSent = undefined;
    send();
};

// Roster frames land here (from useSandboxLiveness). Self-heal: our own entry arriving blank while we have
// activity means the initial report raced the registration (POST landed first, was dropped) — re-send.
export const setPresenceUsers = (next: readonly PresenceUser[]): void => {
    users.value = next;
    const own = clientId !== undefined ? next.find((entry) => entry.clientId === clientId) : undefined;
    if (own !== undefined && own.view === undefined && report.view !== undefined) {
        lastSent = undefined;
        send();
    }
};
