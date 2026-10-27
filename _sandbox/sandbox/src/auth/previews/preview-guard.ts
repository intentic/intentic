import { createHmac, randomBytes } from "node:crypto";
import { writeFileAtomic } from "@intentic/base/fs";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract/ids/hostnames";
import { memberAccess, tierOf } from "@intentic/sandbox-contract/schemas/members";
import type { PreviewGuard as NetdPreviewGuard } from "@intentic/sandbox-contract/netd-wire";
import { PreviewGuardSchema, type PreviewGuardScope } from "@intentic/sandbox-contract/schemas/ports";
import type { MembersStore } from "../auth.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { loadOrMintKey } from "../../store/plain-files/minted-key.js";

// THE OWNER'S GUARD ON PREVIEWS (2026-10-27, docs/architecture/sandbox.md). Off by default; on, a panel's preview (and,
// at `all`, a forwarded port) opens from outside only for a browser holding this sandbox's pass. The daemon decides who
// gets one and signs it; intentic-netd checks it on every request with the key handed over in its listen config
// (_sandbox/netd, guard.rs), so no preview request waits on this process.
//
// A member gets a pass in two steps. The editor asks `POST /previews/pass` with their session and is answered a link
// on the preview's own host carrying a one-time ticket, good for a minute; the browser follows it (in the editor's frame,
// or a tab of its own), netd hands that request back here, and the answer is the pass as a cookie on that host, and a
// redirect to the path asked for. A cookie set by the host itself, inside the frame when the frame is where it is
// opened, is the one kind every browser keeps there: Basic auth was rejected because an app's own `Authorization`
// replaces it, and the desktop and phone webviews cancel its prompt.

// Where netd hands the exchange back, reserved beside the probe on every covered host.
export const PREVIEW_PASS_PATH = "/__intentic/preview-pass";

// Host-only, HTTPS-only, never readable by the app's scripts, and partitioned by the top-level site (CHIPS): the cookie
// set inside the editor's frame is sent in that frame, also where the preview's zone is another site than the editor's
// (a self-hosted zone), and a page on any other site framing the preview gets none.
export const PREVIEW_PASS_COOKIE = "__Host-intentic-preview-pass";

// What a pass is worth before the editor quietly fetches another. The guard is ended for everyone at once by a new key,
// so the lifetime bounds only a copied cookie; a week keeps a tab left open over a working week from asking again.
export const PREVIEW_PASS_TTL_SECONDS = 7 * 24 * 60 * 60;

// The link's ticket: long enough for a slow tunnel hop, short enough that a link someone copied is already spent.
const TICKET_TTL_MS = 60_000;

// The one format netd checks (guard.rs `verifies`).
const PASS_VERSION = "v1";

export const previewGuardDocument = defineDocument({
    root: "auth",
    path: "preview-guard.json",
    schema: PreviewGuardSchema,
});

export interface PreviewGuardStore {
    // Throws when the file exists and cannot be read: the guard is then unknown, and read as on (`previewGuardForNetd`).
    readonly scope: () => Promise<PreviewGuardScope>;
    readonly setScope: (scope: PreviewGuardScope) => Promise<void>;
}

export const filePreviewGuardStore = (path: string): PreviewGuardStore => {
    const file = openDocument(previewGuardDocument, path, {
        mode: 0o600,
        fallback: () => PreviewGuardSchema.parse({}),
        onUnreadable: "refuse",
    });
    return {
        scope: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`the preview guard at ${path} is unreadable (${state.detail})`);
            }
            return state.value.scope;
        },
        setScope: async (scope) => {
            await file.update(() => PreviewGuardSchema.parse({ scope }));
        },
    };
};

// The pass's signing key as text, kept at `<history>/preview-pass.key` beside the session secret (auth/auth-slice.ts):
// minted on first use, replaced to end every pass, never carried to another sandbox (store/evolution/history-state.ts).
// The text is what netd is handed and what both sides take the HMAC key's bytes from.
export interface PreviewPassKey {
    readonly read: () => Promise<string>;
    readonly rotate: () => Promise<void>;
}

export const filePreviewPassKey = (path: string): PreviewPassKey => {
    let key: Promise<string> | undefined;
    const keep = (loading: Promise<string>): Promise<string> => {
        key = loading;
        // A failed read is not kept, so the next use reads again rather than failing until restart.
        loading.catch(() => {
            if (key === loading) {
                key = undefined;
            }
        });
        return loading;
    };
    return {
        read: () => key ?? keep(loadOrMintKey(path, { bytes: 32, encoding: "base64url" }).then((bytes) => bytes.toString("base64url"))),
        // Written whole and flushed, so a crash leaves the old key or the new one; cached first, so a pass minted while
        // the write lands is signed with the key netd is about to be told.
        rotate: async () => {
            const fresh = randomBytes(32).toString("base64url");
            await keep(writeFileAtomic(path, fresh, 0o600, { durable: true }).then(() => fresh));
        },
    };
};

// The pass's cookie value for an expiry, as netd checks it: `v1.<expiry>.<HMAC-SHA256 of v1.<expiry>>`, base64url.
export const signPass = (key: string, expiresAt: number): string => {
    const signed = `${PASS_VERSION}.${String(expiresAt)}`;
    return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
};

// The Set-Cookie that carries a pass, for the host the exchange arrived on.
export const passCookie = (value: string, maxAge: number = PREVIEW_PASS_TTL_SECONDS): string =>
    `${PREVIEW_PASS_COOKIE}=${value}; Path=/; Max-Age=${String(maxAge)}; Secure; HttpOnly; SameSite=None; Partitioned`;

// Who may hold a pass: the owner, and anyone on the roster above a guest, whose door is their assistants and not the
// workspace's apps. Read fresh, like every authorization.
export const opensPreviews =
    (owner: () => Promise<string | undefined>, members: Pick<MembersStore, "list">) =>
    async (email: string): Promise<boolean> => {
        const wanted = email.toLowerCase();
        if ((await owner())?.toLowerCase() === wanted) {
            return true;
        }
        const member = (await members.list()).find((row) => row.email.toLowerCase() === wanted);
        return member !== undefined && tierOf(memberAccess(member)) !== "guest";
    };

// What a preview address is to this sandbox: one of its own names, and whether the guard covers it now.
type AddressKind = "panel" | "port" | "outbox";

export interface PreviewGuards {
    readonly scope: () => Promise<PreviewGuardScope>;
    // The scope stored, and netd told at once.
    readonly set: (scope: PreviewGuardScope) => Promise<PreviewGuardScope>;
    // What netd is handed in its listen config: undefined while off. A scope that cannot be read guards everything.
    readonly forNetd: () => Promise<NetdPreviewGuard | undefined>;
    // Which of this sandbox's preview names `url` is, or undefined for any other address (another zone, another
    // sandbox, not HTTPS): a ticket is only ever minted for a host netd will hand back here.
    readonly kindOf: (url: URL) => AddressKind | undefined;
    // Whether a preview of that kind needs a pass now.
    readonly covers: (kind: AddressKind) => Promise<boolean>;
    // A one-time ticket for this member on this host.
    readonly ticket: (email: string, host: string) => string;
    // The member a ticket was minted for, if it was minted for this host and is unspent and unexpired; spent either way.
    readonly redeem: (ticket: string, host: string) => string | undefined;
    // The pass's cookie value, good for the pass's lifetime from now.
    readonly pass: () => Promise<string>;
    // Someone's access changed (auth/connections.ts `onRevoke`, every member when undefined): their unspent tickets go,
    // and when they may no longer open previews, or it was everyone's, the key is replaced so every pass ends.
    readonly revoked: (email: string | undefined) => Promise<void>;
    // Hears every change netd must be told: a scope set, a key replaced.
    readonly onChange: (listener: () => void) => () => void;
}

export interface PreviewGuardDeps {
    readonly store: PreviewGuardStore;
    readonly key: PreviewPassKey;
    // This sandbox's minted id and its zone; without both it has no public preview names, and nothing is ever covered.
    readonly sandboxId: string | undefined;
    readonly zone: string | undefined;
    readonly mayPass: (email: string) => Promise<boolean>;
    readonly now?: () => number;
}

export const createPreviewGuards = (deps: PreviewGuardDeps): PreviewGuards => {
    const now = deps.now ?? Date.now;
    const listeners = new Set<() => void>();
    const changed = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    const tickets = new Map<string, { readonly email: string; readonly host: string; readonly expiresAt: number }>();
    const sweep = (): void => {
        for (const [ticket, entry] of tickets) {
            if (entry.expiresAt < now()) {
                tickets.delete(ticket);
            }
        }
    };
    const rotate = async (): Promise<void> => {
        await deps.key.rotate();
        changed();
    };
    return {
        scope: () => deps.store.scope(),
        set: async (scope) => {
            await deps.store.setScope(scope);
            changed();
            return scope;
        },
        forNetd: async () => {
            const scope = await deps.store.scope().catch((): PreviewGuardScope => "all");
            if (scope === "off") {
                return undefined;
            }
            // A key that cannot be read guards with one nobody holds: closed until it can be, never open.
            const key = await deps.key.read().catch(() => randomBytes(32).toString("base64url"));
            return { panels: true, ports: scope === "all", cookie: PREVIEW_PASS_COOKIE, key, passPath: PREVIEW_PASS_PATH };
        },
        kindOf: (url) => {
            const { sandboxId, zone } = deps;
            if (sandboxId === undefined || zone === undefined || zone === "" || url.protocol !== "https:" || url.port !== "") {
                return undefined;
            }
            const host = url.hostname.toLowerCase();
            if (!host.endsWith(`.${zone.toLowerCase()}`) || host.split(".").length !== zone.split(".").length + 1) {
                return undefined;
            }
            if (panelFromHost(host, sandboxId) !== undefined) {
                return "panel";
            }
            if (portSlotFromHost(host, sandboxId) !== undefined) {
                return "port";
            }
            return publicSlotFromHost(host, sandboxId) !== undefined ? "outbox" : undefined;
        },
        covers: async (kind) => {
            if (kind === "outbox") {
                return false;
            }
            const scope = await deps.store.scope();
            return scope === "all" || (scope === "panels" && kind === "panel");
        },
        ticket: (email, host) => {
            sweep();
            const ticket = randomBytes(32).toString("base64url");
            tickets.set(ticket, { email: email.toLowerCase(), host: host.toLowerCase(), expiresAt: now() + TICKET_TTL_MS });
            return ticket;
        },
        redeem: (ticket, host) => {
            const entry = tickets.get(ticket);
            // Spent on any hit, expired or not, so a replay in the same millisecond finds nothing.
            tickets.delete(ticket);
            return entry === undefined || entry.expiresAt < now() || entry.host !== host.toLowerCase() ? undefined : entry.email;
        },
        pass: async () => signPass(await deps.key.read(), Math.floor(now() / 1000) + PREVIEW_PASS_TTL_SECONDS),
        revoked: async (email) => {
            for (const [ticket, entry] of tickets) {
                if (email === undefined || entry.email === email.toLowerCase()) {
                    tickets.delete(ticket);
                }
            }
            // A grant that keeps someone able to open previews leaves every pass alone; anything less ends them all, since
            // a pass does not say whose it is.
            let keeps = false;
            if (email !== undefined) {
                try {
                    keeps = await deps.mayPass(email);
                } catch {
                    // allow(silent-catch): a roster that cannot be read keeps nobody's pass; replacing the key costs members only a fresh one.
                    keeps = false;
                }
            }
            if (!keeps) {
                await rotate();
            }
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
