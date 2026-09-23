import type { SetupReport } from "@intentic/api-contract";

// Where the install command is on its way to a machine, why none is on screen yet, and when a quiet wait needs a word.

// `locked` no command yet (`lockedReasonOf` says what is missing); `yours` shown, nothing in flight; `handed` copied or
// given to the app, waiting on the reader's machine; `claimed` a machine redeemed the code, so the wait is earned.
export type Handoff = `locked` | `yours` | `handed` | `claimed`;

export interface HandoffInput {
    readonly commandReady: boolean;
    readonly claimedAt: string | null;
    readonly report: SetupReport | null;
    readonly copied: boolean;
    readonly launched: boolean;
}

export const handoffOf = ({ commandReady, claimedAt, report, copied, launched }: HandoffInput): Handoff => {
    if (!commandReady) {
        return `locked`;
    }
    // A report is proof like the claim stamp, and can arrive first (a preflight failure before redemption).
    if (claimedAt !== null || report !== null) {
        return `claimed`;
    }
    return copied || launched ? `handed` : `yours`;
};

export interface LockInput {
    readonly addressless: boolean;
    readonly mode: `intentic` | `own`;
    // The failed mint's title; interpolated whole, a notice renders as its own JSON.
    readonly mintError: string | undefined;
    readonly cfToken: string;
    readonly cfTokenValid: boolean;
    readonly zonesLoading: boolean;
    readonly zonesError: string | undefined;
    readonly zone: string | undefined;
    readonly subdomainValid: boolean;
}

// The own-zone form's first unanswered question, or undefined once every answer is in.
const zoneQuestion = (lock: LockInput): string | undefined => {
    if (lock.cfToken.length === 0) {
        return `Enter your Cloudflare API token to reveal your install command.`;
    }
    if (!lock.cfTokenValid) {
        return `Your install command appears once the token above looks valid.`;
    }
    if (lock.zonesLoading) {
        return `Checking which Cloudflare zones this token can use…`;
    }
    if (lock.zonesError !== undefined) {
        return `Fix the Cloudflare token issue above to continue.`;
    }
    if (lock.zone === undefined) {
        return `Choose which Cloudflare zone to use to reveal your command.`;
    }
    return lock.subdomainValid ? undefined : `Enter a valid subdomain (letters, numbers, hyphens) to reveal your command.`;
};

// Why no command is on screen yet, in the words of what is missing.
export const lockedReasonOf = (lock: LockInput): string => {
    // Not a wait: no command is coming, so this states the fact rather than saying 'Preparing…', which read as hung.
    if (lock.addressless) {
        return `This platform doesn't hand out addresses, so there's no install command to run. Connect a sandbox you're already running instead.`;
    }
    if (lock.mode === `intentic`) {
        return lock.mintError ?? `Preparing your intentic domain…`;
    }
    return zoneQuestion(lock) ?? lock.mintError ?? `Preparing your install command…`;
};

// Once the wait reads as a misunderstanding (ms): a long fuse wherever the command is not the path (compose, a phone,
// an installer), a short one beside a command to paste.
export const nudgeAfterMs = (roundabout: boolean): number => (roundabout ? 3 * 60_000 : 40_000);
// Past this (ms), the correction stops assuming the command never ran and helps a terminal that errored instead.
export const STALLED_MS = 3 * 60_000;
// Claimed with no report yet (ms): only an ic older than reports (a desktop app's pinned one) is silent this long.
export const SLOW_BUILD_MS = 6 * 60_000;

// When the wait started (ms): the command becoming runnable, or the reader's last visible act where that is later.
export const waitedFrom = (armedAt: number | undefined, actedAt: number | undefined): number | undefined =>
    actedAt !== undefined && armedAt !== undefined ? Math.max(actedAt, armedAt) : armedAt;

export type NudgeVariant = `emailed` | `terminal` | `downloaded` | `install` | `phone` | `app` | `button`;

export interface NudgeReader {
    readonly mobile: boolean;
    // A link back to this screen went to the reader's inbox: their next move is on a laptop, not in a terminal.
    readonly emailed: boolean;
    readonly commandVisible: boolean;
    // The browser offered an installer: nothing was meant to be pasted, and the app's own button does not exist yet.
    readonly installing: boolean;
    readonly downloaded: boolean;
    readonly launched: boolean;
}

// Which reader the correction addresses (SetupNudge draws it).
export const nudgeVariantOf = (reader: NudgeReader): NudgeVariant => {
    if (reader.mobile && reader.emailed) {
        return `emailed`;
    }
    if (reader.commandVisible) {
        return `terminal`;
    }
    if (reader.installing) {
        // Once downloaded, the correction must move on too, or it reads as not noticing the reader's own action.
        return reader.downloaded ? `downloaded` : `install`;
    }
    if (reader.mobile) {
        return `phone`;
    }
    return reader.launched ? `app` : `button`;
};
