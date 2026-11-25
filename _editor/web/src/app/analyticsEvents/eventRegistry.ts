import { z } from "zod";

/* EVERY PRODUCT EVENT THE EDITOR SENDS, AND WHAT EACH MAY CARRY (2026-11-24). `track` (../analytics.ts) takes only a
   name listed here, with exactly the properties its schema names, so a call site that adds a free-text branch, a file
   name or a title fails to compile, and anything that slips past the compiler (a cast, a value wider than its type) is
   dropped at runtime by validate.ts before it is queued or sent. Before this the rule was a comment in eventPrivacy.ts
   that nothing enforced.

   Values are enums, counts, flags and short identifier-shaped codes. A property that has to carry words is spelled
   `text(n)` so it stands out in review, and is scrubbed at its call site first (`sandbox_setup_failed`'s `problem`).
   Adding an event: one entry here, then the call. Renaming one splits its funnel in PostHog, so names stay as they are. */

// A count, a duration or a percentage. Numbers carry no workspace content, so they are only held to being finite.
const num = z.number().finite();
// A code from a closed set this module does not own (a failure code, a provider id, a model name): letters, digits and
// `_ - . :` only, so no spaces and no slashes, and short. Not a path, a sentence or an address.
const token = z.string().max(64).regex(/^[\w.:-]*$/);
// Words a call site scrubbed itself; the length is the event's own cap.
const text = (max: number) => z.string().max(max);
const flag = z.boolean();
const nothing = z.strictObject({});

const signInSurface = z.enum([`login`, `dialog`, `invite`, `confirm`, `desktop-auth`]);
const emailCodeStage = z.enum([`send`, `resend`, `verify`, `link`]);
const invitePlace = z.strictObject({ place: z.enum([`finished`, `menu-note`, `menu`, `phone-note`, `phone-menu`, `palette`]) });
const tourStep = z.enum([`work`, `agent`, `models`, `land`]);
const downloadMb = { downloadedMb: num.optional(), downloadTotalMb: num.optional() };
const slowDownload = z.strictObject({ remainingSeconds: num.nullable(), ...downloadMb });

export const ANALYTICS_EVENTS = {
    // Account milestones, once per account per browser (analytics.ts `once`).
    signed_up: z.strictObject({ method: z.enum([`google`, `email`]), $set_once: z.strictObject({ signed_up_at: token.optional() }) }),
    first_turn_completed: z.strictObject({ agent: token, $set_once: z.strictObject({ first_turn_completed_at: token }) }),

    // Signing in.
    sandbox_signin_gate: z.strictObject({
        reason: z.enum([`daemon-401`, `refused`, `skipped`, `dismissed`, `guard-timeout`, `webview`, `button-stalled`]),
        mode: token.optional(),
        surface: signInSurface.optional(),
        fedcm: flag.optional(),
        left: flag.optional(),
    }),
    signin_completed: z.strictObject({
        method: z.enum([`google`, `email`]),
        via: z.enum([`code`, `link`]).optional(),
        surface: signInSurface,
        help_shown: flag.optional(),
        stall_shown: flag.optional(),
    }),
    signin_code_requested: z.strictObject({ surface: signInSurface, google_address: flag.optional() }),
    signin_code_resent: z.strictObject({ surface: signInSurface, help_shown: flag }),
    signin_code_waiting: z.strictObject({ surface: signInSurface }),
    signin_code_failed: z.strictObject({ surface: signInSurface, stage: emailCodeStage, reason: token }),
    desktop_signin_arrived: z.strictObject({ via: token, ok: flag }),
    desktop_handoff_sent: z.strictObject({ user_activation: flag.optional(), sends: num }),

    // Reaching a sandbox.
    sandbox_wake: z.strictObject({ source: z.enum([`retry`, `switch`]), outcome: token }),
    sandbox_unreachable: z.strictObject({ cause: z.enum([`asleep`, `machine-offline`, `starting`, `down`]), hosted: flag }),

    // Adding and setting up a sandbox.
    sandbox_add_started: z.strictObject({ target: token, mode: token.optional(), resumed: flag.optional() }),
    sandbox_add_hosted_instead: nothing,
    sandbox_hosted_created: z.strictObject({ machine: z.enum([`hosted`]), tier: token, resumed: flag }),
    sandbox_connected: z.strictObject({ resuming: flag, machine: z.enum([`own`, `hosted`]), attached: z.literal(true).optional() }),
    sandbox_command_copied: z.strictObject({ tab: token, sync: flag, mobile: flag }),
    sandbox_command_claimed: z.strictObject({ resuming: flag }),
    sandbox_setup_link_emailed: z.strictObject({ resuming: flag }),
    // `problem` is the machine's own words, scrubbed by `scrubDiagnostic` and cut to 600 characters (setupReport.ts).
    sandbox_setup_failed: z.strictObject({ stage: token, checks: text(400), problem: text(600) }),
    setup_target_picked: z.strictObject({ target: z.enum([`here`, `machine`]), machines: num }),
    setup_on_machine_started: z.strictObject({ machines: num }),
    setup_slow_download_offered: slowDownload,
    setup_slow_download_hosted: slowDownload,
    desktop_setup_started: z.strictObject({ mode: token, inApp: flag, sync: flag, project: flag }),
    desktop_setup_report: z.strictObject({
        state: token,
        percent: num,
        step: token.optional(),
        waitingFor: token.optional(),
        requirements: z.array(token).max(32).readonly().optional(),
        ...downloadMb,
    }),
    desktop_installer_downloaded: z.strictObject({ platform: token }),
    gpu_capability_blocked: z.strictObject({ hosted: flag }),

    // Conversations and turns.
    message_sent: z.strictObject({ agent: token, queued: flag.optional(), scheduled: flag.optional() }),
    message_edited: z.strictObject({ agent: token }),
    conversation_forked: z.strictObject({ agent: token, files: token, whole: flag }),
    turn_refused: z.strictObject({ via: z.enum([`door`, `held`]), agent: token, status: num.optional(), code: token.optional() }),
    turn_failed: z.strictObject({ code: token, repeats: num }),
    way_out_shown: z.strictObject({ layer: token, recommended: token.optional(), repeats: num }),
    way_out_taken: z.strictObject({ way: token, recommended: flag, layer: token }),
    way_out_outcome: z.strictObject({ way: token, ok: flag }),
    land_failed: z.strictObject({ code: token, refused_count: num.optional(), delta_files: num.optional() }),
    sessions_synthesized: z.strictObject({ sources: num }),
    git_op_slow: z.strictObject({ op: token, files: num, ms: num }),

    // Voice.
    voice_started: z.strictObject({ pressToListeningMs: num, model: token, loaded: flag, transport: token }),
    voice_phrase: z.strictObject({ transport: token, engine: token, endToTextMs: num, decodeMs: num.optional(), heard: flag }),
    voice_bridged: z.strictObject({ engine: token }),
    voice_failed: z.strictObject({ code: token }),
    voice_wake_on: nothing,
    voice_wake_off: nothing,
    voice_wake_listening: nothing,
    voice_wake_failed: z.strictObject({ code: token }),
    voice_wake_heard: z.strictObject({ whole: flag, request: flag }),
    voice_wake_yielded: nothing,
    voice_wake_cancelled: nothing,
    voice_wake_routed: z.strictObject({ kind: token, why: token, switched: flag.optional(), empty: flag.optional() }),

    // The getting-started checklist and the community invite.
    // A hint can also point at the board, which is not a checklist step of its own (tour/tourMarks.ts `MarkStep`).
    tour_step_shown: z.strictObject({ step: z.enum([...tourStep.options, `board`]), place: token }),
    tour_step_done: z.strictObject({ step: tourStep }),
    tour_step_skipped: z.strictObject({ step: tourStep }),
    tour_hidden: z.strictObject({ settled: num, finished: flag }),
    community_invite_shown: invitePlace,
    community_invite_opened: invitePlace,
    community_invite_declined: invitePlace,
} as const satisfies Record<string, z.ZodObject>;

export type AnalyticsEvent = keyof typeof ANALYTICS_EVENTS;
/** What a call site hands `track` for `E`: the schema's input, so a property its type allows but the schema refuses is a compile error. */
export type EventProperties<E extends AnalyticsEvent> = z.input<(typeof ANALYTICS_EVENTS)[E]>;
/** What a registered event sends, once its schema has read it. */
export type SentProperties = z.output<(typeof ANALYTICS_EVENTS)[AnalyticsEvent]>;
