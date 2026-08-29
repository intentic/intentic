import { z } from "zod";
// version: what this daemon runs (baked). latest/updateAvailable: the daemon compares its version to the
// latest published `stable` release so the web can offer a non-blocking update (see system/version-check.ts).
/* Whether an agent runtime can serve a turn right now, probed off the turn path (see the sandbox's
 * agent/adapter-health.ts). "unknown" is a real answer, a probe that could not run must not read as
 * "unavailable" and grey out a provider the user can in fact use, so surfaces treat it as
 * available-but-unverified rather than as a soft no. */
export const AdapterHealthSchema = z.object({
    state: z
        .enum(["ready", "unavailable", "unknown"])
        .describe(
            "Whether this runtime can serve a turn. Unknown is a real answer rather than a soft no: a check that could not run must not grey out a provider you can in fact use.",
        ),
    // Why it cannot serve, in the user's terms and naming what to do about it. Absent when ready.
    detail: z.string().optional().describe("Why it cannot, and what to do about it. Absent when it can."),
    checkedAt: z.number().describe("When it was last checked, in milliseconds."),
});
export type AdapterHealthReport = z.infer<typeof AdapterHealthSchema>;
/* AN UPDATE ALREADY DOWNLOADED AND BUILT, waiting for the restart that applies it.
 *
 * An update is one blocking operation but it was never one kind of work: pulling the new image and re-applying
 * the environment recipe take the overwhelming majority of the wall clock, and the sandbox is up and serving
 * through both of them. Only the cutover is downtime, and it is seconds.
 *
 * The daemon cannot know any of this by itself, it holds no host Docker socket, so `ic sandbox prepare`
 * tells it, on the machine that runs the container. That is the whole reason this exists: without it, the
 * update card had to quote the download as if it were an outage, and "a few minutes, this page loses the
 * sandbox" is a completely different decision from "about half a minute".
 *
 * Advisory only, in the strict sense: it decides what a card SAYS and never what gets installed. The swap
 * re-derives every one of these facts from the host-side record and refuses the fast path if any has drifted. */
export const StagedUpdateSchema = z.object({
    // The version the staged image reports about itself. Absent when the image would not say (an older build,
    // a probe that failed), which reads as "ready, version unknown", never as nothing being ready.
    version: z.string().optional().describe("What the downloaded build says it is. Absent means ready but unnamed, never that nothing is ready."),
    // The release channel it was staged FROM, which is not necessarily the one this sandbox follows: preparing
    // a beta build is not moving onto beta.
    channel: z
        .string()
        .describe(
            "Which channel it was taken from. Not necessarily the one this sandbox follows: downloading a beta build is not the same as moving onto beta.",
        ),
    // When it finished downloading, epoch ms, what answers "is this still the update I am being offered?"
    at: z.number().describe("When the download finished, in milliseconds, which answers whether this is still the update being offered."),
});
export type StagedUpdate = z.infer<typeof StagedUpdateSchema>;
export const InfoSchema = z.object({
    name: z.string().optional().describe("What this sandbox is called."),
    image: z.string().optional().describe("The image it is running."),
    version: z.string().optional().describe("The version of that image."),
    latest: z.string().optional().describe("The newest published version on its channel."),
    updateAvailable: z.boolean().optional().describe("Whether those two differ."),
    // Keyed by AgentCapabilities.runtime. Absent until the first background sweep lands, which reads the same
    // as every entry being "unknown", one of the two cannot go stale, so the daemon sends the absence.
    runtimes: z
        .record(z.string(), AdapterHealthSchema)
        .optional()
        .describe(
            "Which agent runtimes can serve a turn right now, keyed by runtime. Absent until the first check has run, which reads the same as every entry being unknown.",
        ),
    /* Which release channel this sandbox follows (`stable` unless it was moved), and the base image the last
     * swap replaced, both set on the container by the host script that performed the swap, since neither is
     * knowable from inside afterwards. `previousImage` is what a rollback returns to; absent means there is
     * nothing to go back to and no rollback is offered. */
    channel: z.string().optional().describe("Which release channel this sandbox follows."),
    previousImage: z
        .string()
        .optional()
        .describe("The image the last update replaced, which is what a rollback would return to. Absent means there is nothing to go back to."),
    /* WHAT IS IN THE UPDATE, in the words of the people it is for, the user-facing lines from every release
     * between `version` and `latest`, newest first (platform/release-notes.ts reads them off the published
     * GitHub Releases).
     *
     * The update card's other half. It could always say an update exists and what taking it costs, recreating
     * the container interrupts every agent mid-turn, and never what the update was worth, which left the
     * decision it asks for with nothing on one side of it.
     *
     * Absent, or empty, whenever there is nothing to say: the notes cache is cold, GitHub is unreachable, or
     * every release in the gap changed only things nobody outside the project would notice. All three read the
     * same way on the card, which shows the offer without them, exactly as it did before. */
    updateNotes: z
        .array(z.string())
        .optional()
        .describe(
            "What is in the update, in the words of the people it is for, newest first. Absent or empty whenever there is nothing worth saying, which reads on screen exactly as it did before there were notes at all.",
        ),
    // How many further notes the gap holds beyond the ones sent, for a sandbox that has been left alone a long
    // time. Absent or 0 ⇒ `updateNotes` is the whole of it.
    moreUpdateNotes: z
        .number()
        .optional()
        .describe(
            "How many further notes there are beyond the ones sent, for a sandbox left alone a long time. Absent or zero means you have all of them.",
        ),
    /* WHAT THE UPDATE TAKES AWAY, the "Breaking changes" lines from every release in the same gap, uncapped
     * (a warning that fell off a truncated list is a breaking update taken unwarned). Their presence is what
     * turns the update card from an offer into a warning that asks to be read before it hands over the
     * command. Absent for the overwhelming majority of updates, which break nothing. */
    breakingNotes: z
        .array(z.string())
        .optional()
        .describe(
            "What the update takes away, uncapped, because a warning that fell off a shortened list is a breaking update taken unwarned. Absent for the overwhelming majority, which break nothing.",
        ),
    /* AN UPDATE THAT HAS ALREADY BEEN DOWNLOADED AND BUILT on the machine that runs this container, and is
     * waiting for the restart that applies it. Absent for the ordinary case where nothing is staged. */
    staged: StagedUpdateSchema.optional().describe(
        "An update already downloaded and built on the machine running this container, waiting only for the restart that applies it. That restart is seconds, where an unprepared update is minutes, which is a different decision entirely. Absent when nothing is waiting.",
    ),
});
export type Info = z.infer<typeof InfoSchema>;
/* WHAT THE DAEMON COULD NOT READ IN ITS OWN STATE FILES.
 *
 * Every manifest under `.intentic/` is read through a schema and falls back when that schema says no, which
 * keeps the daemon up and, until this route, ended there. A settings file with one bad character read as
 * every setting at its default, a misspelled flag was stripped in silence, and a skipped capability said so
 * only in the daemon log. All three look identical from a browser: the feature is simply off.
 *
 * `kind` is what to do about it, which is why it is not just a message:
 *   unreadable  , the whole file is being ignored. Everything in it is at its default.
 *   unknownKey  , one key this build does not know. Only that key is ignored, and `suggestion` carries the
 *                  name it was probably meant to be, when one is close enough to guess honestly.
 *   invalidEntry, one entry of a list was skipped. The rest of the file is unaffected.
 *
 * Reported per file rather than as one flat list because the file is the unit a person fixes, and only for the
 * files a person CAN fix (REPORTED_MANIFEST_PATHS in workspace-state.ts). A daemon-written ledger that stops
 * matching a tightened schema is not a repair job to hand the owner; it recovers on its own next write. */
export const ManifestProblemSchema = z.object({
    kind: z
        .enum(["unreadable", "unknownKey", "invalidEntry"])
        .describe(
            "What to do about it. Unreadable means the whole file is being ignored and everything in it is at its default. An unknown key means only that key is ignored. An invalid entry means one item of a list was skipped and the rest is fine.",
        ),
    detail: z.string().describe("What exactly was wrong."),
    suggestion: z.string().optional().describe("The name it was probably meant to be, when one is close enough to guess honestly."),
});
export type ManifestProblem = z.infer<typeof ManifestProblemSchema>;
// Workspace-relative path (`.intentic/config/settings.json`) and everything currently wrong with that file. A file
// with nothing wrong is absent from the list rather than present and empty.
export const ManifestProblemReportSchema = z.object({
    path: z.string().describe("The file, as a workspace path. The file is the unit somebody fixes, which is why problems are grouped by it."),
    problems: z
        .array(ManifestProblemSchema)
        .describe("Everything currently wrong with it. A file with nothing wrong is absent rather than present and empty."),
});
export type ManifestProblemReport = z.infer<typeof ManifestProblemReportSchema>;
export const ManifestProblemsSchema = z.array(ManifestProblemReportSchema);
// A daemon-minted session (system.session): the steady-state browser credential, exchanged for a verified
// Google ID token so Google UI is a sign-in moment instead of an hourly renewal. `expiresAt` is epoch ms,
// the browser renews ahead of it without parsing the token; `email` is who the daemon verified.
export const DaemonSessionSchema = z.object({
    token: z.string().describe("The credential every other call carries. Present it as a bearer token."),
    expiresAt: z.number().describe("When it stops working, in milliseconds, so a caller can renew ahead of it without reading the token."),
    email: z.string().describe("Who the sandbox verified you as."),
});
export type DaemonSession = z.infer<typeof DaemonSessionSchema>;
