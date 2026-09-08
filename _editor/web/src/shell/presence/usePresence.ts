import type { MemberRole, PresenceUser } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { sandboxRequest } from "../../features/sandbox/client/sandboxClient";
import { useAuth } from "../../features/auth/useAuth";

// Live presence: who else is on the active sandbox and what they're doing. Module-level singleton with two
// halves: the roster (fed by useSandboxLiveness's /events frames, last frame wins) and the reporter (this tab's
// activity, debounced, fire-and-forget). Lives only while the shell holds the liveness stream open.

const { user } = useAuth();

// Roster (inbound).

const users = ref<readonly PresenceUser[]>([]);

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

export const viewersOfPath = (path: string): readonly PresenceMember[] =>
    presenceOthers.value.filter((member) => member.tabs.some((tab) => tab.path === path));

export const viewersOfSession = (sessionId: string): readonly PresenceMember[] =>
    presenceOthers.value.filter((member) => member.tabs.some((tab) => tab.sessionId === sessionId));

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

export const resetPresence = (): void => {
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
