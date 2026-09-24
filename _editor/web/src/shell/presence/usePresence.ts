import type { MemberRole, PresenceUser } from "@intentic/sandbox-contract";
import { sandboxRef } from "@intentic/extension-api";
import { computed } from "vue";
import { sandboxRpc } from "../../features/sandbox/client/sandboxRpc";
import { useAuth } from "../../features/auth/useAuth";

// Live presence: who else is on the active sandbox and what they're doing. Module-level singleton with two
// halves: the roster (fed by useSandboxLiveness's /events frames, last frame wins) and the reporter (this tab's
// activity, debounced, fire-and-forget). Lives only while the shell holds the liveness stream open.

const { user } = useAuth();

// Roster (inbound). The daemon it came from's own: the incoming sandbox's stream repaints it on connect.

const users = sandboxRef<readonly PresenceUser[]>(() => []);

// One other member of the sandbox, aggregated across their open tabs.
export interface PresenceMember {
    readonly email: string;
    readonly name?: string;
    readonly picture?: string;
    // Trust tier resolved by the daemon per connection; every tab of a member carries the same one.
    readonly role: MemberRole;
    // Idle only when every tab is hidden; one visible tab means they're here.
    readonly idle: boolean;
    readonly tabs: readonly PresenceUser[];
}

// Everyone but me, one entry per member: active first, alphabetical within, so the stack stays stable while the
// roster churns.
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
            role: first.role,
            idle: tabs.every((tab) => tab.idle),
            tabs,
        });
    }
    return members.toSorted((a, b) => Number(a.idle) - Number(b.idle) || a.email.localeCompare(b.email));
});

const NOBODY: readonly PresenceMember[] = [];

// Members per file and per chat, in roster order, built once per roster: a lookup returns the same array until someone
// moves, so a row that redraws for its own reasons hands its avatars an unchanged prop and they stay as they are.
const byPlace = computed(() => {
    const paths = new Map<string, PresenceMember[]>();
    const sessions = new Map<string, PresenceMember[]>();
    const place = (at: Map<string, PresenceMember[]>, key: string | undefined, member: PresenceMember): void => {
        if (key === undefined) {
            return;
        }
        const members = at.get(key) ?? at.set(key, []).get(key)!;
        // A member's tabs are walked together, so two of theirs in one place are adjacent here.
        if (members.at(-1) !== member) {
            members.push(member);
        }
    };
    for (const member of presenceOthers.value) {
        for (const tab of member.tabs) {
            place(paths, tab.path, member);
            place(sessions, tab.sessionId, member);
        }
    }
    return { paths, sessions };
});

export const viewersOfPath = (path: string): readonly PresenceMember[] => byPlace.value.paths.get(path) ?? NOBODY;

export const viewersOfSession = (sessionId: string): readonly PresenceMember[] => byPlace.value.sessions.get(sessionId) ?? NOBODY;

// What a member is doing, for tooltips, from their most specific tab, visible tabs first.
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

// Clears the roster while the stream is down, where nobody's presence can be vouched for.
export const clearPresence = (): void => {
    users.value = [];
};

// Reporter (outbound).

const DEBOUNCE_MS = 300;

// This tab's current /events connection id, set by the liveness loop per attempt, plus its activity state.
let clientId: string | undefined;
const report: { idle: boolean; view?: string; sessionId?: string; path?: string } = { idle: false };
let lastSent: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

// Fires DEBOUNCE_MS after the first change in a window, coalescing a burst into one report read at fire time.
// Fire-and-forget: a lost or rejected report self-heals on the next change or reconnect resend.
const send = (): void => {
    timer ??= setTimeout(() => {
        timer = undefined;
        if (clientId === undefined) {
            return;
        }
        const presence = { clientId, ...report };
        const body = JSON.stringify(presence);
        if (body === lastSent) {
            return;
        }
        lastSent = body;
        void sandboxRpc.system.presence(presence).catch(() => undefined);
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

// Called after each successful /events open with that connection's fresh id; the daemon's entry for it starts
// blank, so this re-announces activity unconditionally.
export const presenceStreamOpened = (id: string): void => {
    clientId = id;
    lastSent = undefined;
    send();
};

// Roster frames land here. Self-heals a race: our own entry appearing blank while we have activity means the
// initial report beat the registration, so re-send.
export const setPresenceUsers = (next: readonly PresenceUser[]): void => {
    users.value = next;
    const own = clientId !== undefined ? next.find((entry) => entry.clientId === clientId) : undefined;
    if (own !== undefined && own.view === undefined && report.view !== undefined) {
        lastSent = undefined;
        send();
    }
};
