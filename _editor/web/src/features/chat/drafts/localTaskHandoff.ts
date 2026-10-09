import type { LocalTaskHandoff } from "../../../app/environments/localHost";
import { TASK_QUERY } from "../../../app/environments/localHost";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { z } from "zod";

export { TASK_QUERY };

const SENT_KEY = `intentic.firstTask.sent`;

const HandoffSchema = z.object({
    v: z.literal(1),
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(20_000),
});

const fromBase64Url = (value: string): string | undefined => {
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) {
        return undefined;
    }
    const base64 = value.replaceAll(`-`, `+`).replaceAll(`_`, `/`);
    try {
        const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, `=`));
        return new TextDecoder(`utf-8`, { fatal: true }).decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
    } catch {
        // allow(silent-catch): a `?task=` value that is not base64url UTF-8 is a malformed link, which parseTaskHandoff
        // answers with undefined by contract (and the router then drops it from the address).
        return undefined;
    }
};

// Only a SyntaxError means "not JSON"; anything else is a bug, and is thrown.
const parsedJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
};

/** The handoff a `?task=` value carries, or undefined for one that does not decode or validate. */
export const parseTaskHandoff = (raw: string): LocalTaskHandoff | undefined => {
    const text = fromBase64Url(raw);
    const parsed = text === undefined ? undefined : HandoffSchema.safeParse(parsedJson(text));
    return parsed?.success === true ? parsed.data : undefined;
};

// A browser that refuses storage (a SecurityError, a DOMException) has none; anything else is thrown.
const storage = (): Storage | undefined => {
    try {
        return localStorage;
    } catch (error) {
        if (error instanceof DOMException) {
            return undefined;
        }
        throw error;
    }
};

// Without storage nothing was remembered, so the task counts as not sent: this page load sends it once.
export const taskAlreadySent = (id: string): boolean => {
    const raw = storage()?.getItem(SENT_KEY);
    if (raw === null || raw === undefined) {
        return false;
    }
    const ids = z.array(z.string()).safeParse(parsedJson(raw));
    return ids.success && ids.data.includes(id);
};

export const rememberTaskSent = (id: string): void => {
    try {
        const store = storage();
        if (store === undefined) {
            return;
        }
        const ids = z.array(z.string()).safeParse(parsedJson(store.getItem(SENT_KEY) ?? `[]`));
        const kept = ids.success ? ids.data : [];
        if (!kept.includes(id)) {
            kept.push(id);
        }
        store.setItem(SENT_KEY, JSON.stringify(kept.slice(-32)));
    } catch {
        // allow(silent-catch): a browser that refuses storage still sends once per load.
    }
};

let kept: LocalTaskHandoff | undefined;
let looked = false;

/**
 * Router half: a `task` query is kept and the navigation replayed without it. Inert in a local window.
 */
export const receiveTaskHandoff = (
    to: Pick<RouteLocationNormalized, `path` | `query` | `hash`>,
    localWindow: boolean,
    // The router's own reading of where the window is now: chat sits below the router and cannot import it.
    currentPath: () => string,
): true | RouteLocationRaw => {
    if (localWindow) {
        return true;
    }
    const raw = to.query[TASK_QUERY];
    looked = true;
    if (raw === undefined) {
        return true;
    }
    const value = Array.isArray(raw) ? raw[0] : raw;
    const handoff = value === null || value === undefined ? undefined : parseTaskHandoff(value);
    if (handoff !== undefined && !taskAlreadySent(handoff.id)) {
        kept = handoff;
        void import(`./localTaskArrival`).then(({ startLocalTask }) => startLocalTask(currentPath));
    }
    const { [TASK_QUERY]: _taken, ...query } = to.query;
    return { path: to.path, query, hash: to.hash, replace: true };
};

/** Takes the kept handoff for this navigation, if any. */
export const takeTaskHandoff = (): LocalTaskHandoff | undefined => {
    if (!looked) {
        return undefined;
    }
    const handoff = kept;
    kept = undefined;
    return handoff;
};
