import { procedure } from "../protocol/route-meta.js";
import { streamOf } from "../protocol/routes.js";
import { z } from "zod";
import { RosterFramesSchema, SystemEventSchema } from "../events/system-events.js";
import {
    DeviceAgentFlowInputSchema,
    DeviceCommandInputSchema,
    DeviceCommandResultSchema,
    DeviceFlowLineSchema,
    DeviceSandboxFlowInputSchema,
    DevicesListSchema,
} from "../schemas/devices.js";
import {
    DeviceStackDeployInputSchema,
    DeviceStackDeployResultSchema,
    DeviceStackLogsInputSchema,
    DeviceStackOpInputSchema,
    DeviceStacksInputSchema,
    DeviceStacksSchema,
    StackLogsSchema,
    StackOpResultSchema,
} from "../schemas/device-stacks.js";
import { EgressOwnerKeysReadSchema } from "../schemas/egress.js";
import { SandboxReachSchema } from "../schemas/sandbox-reach.js";
import { PresenceReportSchema } from "../schemas/logs.js";
import {
    CheckoutPressInputSchema,
    CheckoutPressResultSchema,
    DiskPressureSchema,
    SandboxMetricsSchema,
    StorageCleanInputSchema,
    StorageCleanResultSchema,
    StorageReportSchema,
} from "../schemas/metrics.js";
import { OkSchema } from "../schemas/shared.js";
import {
    DaemonSessionSchema,
    InfoSchema,
    ManifestProblemsSchema,
    ManifestRepairSchema,
    PresentationReadSchema,
    PresentationRefreshSchema,
} from "../schemas/system.js";
import { AutoUpdateInputSchema, AutoUpdateSchema, SkipUpdateInputSchema } from "../schemas/updates.js";
import {
    BrowserNameParamSchema,
    BrowserPageActionInputSchema,
    BrowserPageParamSchema,
    BrowsersListSchema,
    MoveBrowserPageInputSchema,
    OpenBrowserInputSchema,
    OpenBrowserResultSchema,
    ReopenBrowserPageInputSchema,
    DesktopStateSchema,
    SubagentsListSchema,
    TerminalNameParamSchema,
    TerminalScrollbackQuerySchema,
    TerminalScrollbackSchema,
    TerminalsListSchema,
} from "../schemas/terminal.js";
import { UsageSummarySchema } from "../schemas/providers/usage.js";
import {
    BrowsingForgetInputSchema,
    BrowsingForgetResultSchema,
    BrowsingHistoryQuerySchema,
    BrowsingHistorySchema,
    SearchSuggestQuerySchema,
    SearchSuggestionsSchema,
} from "../schemas/browsing.js";

// The box itself (terminals, devices, sessions, spend), which no control token reaches whatever the floor.
const systemRoute = procedure.meta({ control: "never" });

// Sandbox status/identity, the long-lived liveness stream, and the connect-token-relayed host tunnel. `events`
// interleaves heartbeats, workspaceChanged batches and presence snapshots until the request aborts. `clientId` is this
// tab's presence key; omitting it means never joining the roster.
export const systemContract = {
    info: procedure
        .route({
            method: "GET",
            path: "/info",
            summary: "What this sandbox is",
            description:
                "The sandbox's own identity and state: which workspace it holds, which image it runs, what it is called, and the list of calls it actually implements. Start here, because a browser is routinely newer than the sandbox it is talking to and this is how it finds out what is there.",
        })
        .meta({ guest: true })
        .output(InfoSchema),
    // (2026-11-09) The sandbox's copy of its name and logo, which only the platform decides. Its own route, never a field
    // on /info: /info is read often, and a logo is up to 150 KB. A file read, so it answers while the boot chain runs, for
    // a switcher drawing the sandbox meanwhile; any member reads it, a guest does not.
    presentation: systemRoute
        .route({
            method: "GET",
            path: "/system/presentation",
            summary: "The sandbox's name and logo",
            description:
                "What the owner calls this sandbox and its logo, as the sandbox last heard them from the platform, which holds them. The sandbox keeps this copy so you can still show them while the platform cannot be reached. Null until it has heard them once.",
        })
        .meta({ beforeBoot: true })
        .output(PresentationReadSchema),
    // Any member may ask: it only makes the sandbox ask the platform again, whose word it keeps. The editor calls it right
    // after a rename or a new logo, rather than waiting for the next announce to say they changed.
    presentationRefresh: systemRoute
        .route({
            method: "POST",
            path: "/system/presentation/refresh",
            summary: "Ask the platform for the sandbox's name and logo again",
            description:
                "Makes the sandbox ask the platform for its name and logo now and keep what it answers, typically right after they were changed. When the platform cannot be reached or refuses, the copy the sandbox already held is answered unchanged and `refreshed` is false.",
        })
        .meta({ beforeBoot: true, floor: "viewer" })
        .output(PresentationRefreshSchema),
    // The owner's "not this one" for the update card; /info's `skippedVersion` reads it back.
    skipUpdate: systemRoute
        .route({
            method: "POST",
            path: "/system/update/skip",
            summary: "Stop offering one release",
            description:
                "Stops offering the named release as an update, typically one this sandbox already tried and went back from. A newer release is offered as usual. Null offers the newest release again.",
        })
        // Which version the sandbox runs is the operator's decision, like the update itself.
        .meta({ floor: "maintainer" })
        .input(SkipUpdateInputSchema)
        .output(OkSchema),
    // The owner's say over taking a downloaded update by itself; /info's `autoUpdate` reads the state back.
    autoUpdate: systemRoute
        .route({
            method: "POST",
            path: "/system/update/auto",
            summary: "Decide how updates are taken",
            description:
                "Turns taking a downloaded update by itself on or off, pauses it until a moment, or takes the downloaded update right now. A sandbox taking updates by itself waits for a quiet moment: no agent mid-turn, nobody at the editor, terminals quiet. Answers with where it stands afterwards.",
        })
        // Which version the sandbox runs, and when it restarts onto it, is the operator's decision, like the update itself.
        .meta({ floor: "maintainer" })
        .input(AutoUpdateInputSchema)
        .output(AutoUpdateSchema),
    // Own route, not a field on /info: it goes stale on a manifest changing on disk, not on identity changing.
    manifestProblems: systemRoute
        .route({
            method: "GET",
            path: "/system/manifest-problems",
            summary: "Settings files the sandbox could not read",
            description:
                "Anything the daemon tripped over in its own configuration on disk: a file it had to fall back from, a key it did not recognise, an entry it skipped. Separate from the identity call because it goes stale for a different reason, namely a file changing.",
        })
        .output(ManifestProblemsSchema),
    // Removes or renames only a key, never a value; writes queue through the owning store, not racing a live save.
    repairManifest: systemRoute
        .route({
            method: "POST",
            path: "/system/manifest-problems/repair",
            summary: "Take a stray setting out of a file",
            description:
                "Removes a key the sandbox does not recognise from one of its settings files, or renames it to the one it was probably meant to be, keeping the value. Only the files a person hand-edits can be named, and only a key — never a value — so this can only ever remove something already being ignored. Renaming onto a key the file already has is refused instead of overwriting it.",
        })
        .input(ManifestRepairSchema)
        .output(OkSchema),
    // Trades a verified bearer or unexpired session for a fresh daemon session; calling it again renews it.
    session: systemRoute
        .route({
            method: "POST",
            path: "/system/session",
            summary: "Trade a sign-in for a session",
            description:
                "Exchanges a verified sign-in, or a session that has not expired yet, for a fresh session the daemon minted. That session is the credential every other call carries, and calling this again with a live one renews it.",
        })
        // Staying signed in and on the roster is identity, not power, and needs nothing the boot chain builds.
        .meta({ beforeBoot: true, floor: "viewer", guest: true })
        .output(DaemonSessionSchema),
    events: procedure
        .route({
            method: "GET",
            path: "/events",
            summary: "The live event stream",
            description:
                "A stream held open for as long as you want it, carrying heartbeats so a caller notices the sandbox dying at once, batches of file changes so a tree or an editor can refresh itself, and the roster of who else is looking. Give it an id for this connection to appear in that roster; leave it out and you watch without being seen. It carries the fleet's agents too: ask for their changes and a running agent's progress arrives as only the cards that moved, instead of every card again.",
        })
        .meta({ beforeBoot: true, stream: true, guest: true })
        .input(
            z.object({
                clientId: z.string().optional(),
                // Opt-in, so every client from before it keeps the whole rosters it was written for; a daemon from before
                // it drops the unknown key and sends snapshots, which a client asking for changes still reads.
                roster: RosterFramesSchema.optional().describe(
                    "How the fleet's agents arrive as running agents make progress: `changes` sends only the cards that moved since the previous roster frame, `snapshots` (the default) every card every time. A change someone made, and the first roster, always arrive whole.",
                ),
                // Opt-in for the same reason: a client from before it would not know the frame.
                capacity: z
                    .stringbool()
                    .optional()
                    .describe(
                        "Send each provider's capacity (what its accounts can serve, judged whole) as a `capacity` frame whenever anything under it changes, and again when the clock alone would change it.",
                    ),
            }),
        )
        .output(streamOf(SystemEventSchema)),
    // A tab's activity self-report (view/session/file/idle), fanned back out to every member on /events.
    presence: systemRoute
        .route({
            method: "POST",
            path: "/system/presence",
            summary: "Say what you are looking at",
            description:
                "Reports which view, conversation or file this connection is on, or that it has gone idle. The daemon fans it back out on the event stream so everyone else's roster updates.",
        })
        .meta({ beforeBoot: true, floor: "viewer", guest: true })
        .input(PresenceReportSchema)
        .output(OkSchema),
    // Per-account token/cost totals, aggregated from the activity log's turn.completed events.
    usage: systemRoute
        .route({
            method: "GET",
            path: "/system/usage",
            summary: "What has been spent",
            description: "Token and cost totals per account, added up from the record of every finished turn.",
        })
        // Spend is the operator's reading, not the audience's.
        .meta({ floor: "maintainer" })
        .output(UsageSummarySchema),
    // Measured per request and never in the background: a sandbox nobody is asking pays nothing for this route.
    metrics: systemRoute
        .route({
            method: "GET",
            path: "/system/metrics",
            summary: "What the sandbox is using right now",
            description:
                "CPU and memory for the sandbox as a whole, for the daemon that runs it, for each kind of process, and for each conversation's own processes. Measured when you ask and never in between, so CPU is the use since the previous reading: the first reading after a quiet spell has memory and no CPU, and the next one a few seconds later has both.",
        })
        .output(SandboxMetricsSchema),
    // Answered from memory, never by walking the disk; a daemon restart forgets the last scan.
    storage: systemRoute
        .route({
            method: "GET",
            path: "/system/storage",
            summary: "What is filling the disk",
            description:
                "The last measurement of the sandbox's disk, by what the space is for: conversations, checkouts, restore points, caches, logs, the trash and the rest, each with its biggest parts and whether it can be cleaned from here. Reading it measures nothing; ask for a scan to measure again.",
        })
        // Names every conversation's checkout and every repository on the box: the operator's reading.
        .meta({ floor: "maintainer" })
        .output(StorageReportSchema),
    // Joins a scan already running instead of starting a second one; a time limit bounds it, so it always answers.
    scanStorage: systemRoute
        .route({
            method: "POST",
            path: "/system/storage/scan",
            summary: "Measure what is filling the disk",
            description:
                "Walks the sandbox's volumes and answers with the new measurement once it is done. A scan already running is joined rather than doubled. It stops at a time limit and says so, since a size it could not finish is still worth reading. A cancelled scan answers with the previous measurement.",
        })
        .output(StorageReportSchema),
    cancelStorageScan: systemRoute
        .route({
            method: "DELETE",
            path: "/system/storage/scan",
            summary: "Stop measuring the disk",
            description: "Stops a running scan. Whoever was waiting on it gets the previous measurement back; nothing is lost but the time.",
        })
        .output(OkSchema),
    // Answered from the watch's last reading, never by reading the disk; the `disk` runtime domain says when it moved.
    diskPressure: systemRoute
        .route({
            method: "GET",
            path: "/system/disk-pressure",
            summary: "How close the disk is to full",
            description:
                "The history volume's free space as the sandbox's disk watch last read it, a minute ago at most, and what it did about it: under the reaping threshold (15% free unless the settings say otherwise) it removes build output from checkouts whose conversation has nothing running, and under 10% and 5% it tells the owner. Also the biggest categories of the last storage scan, so a warning can say what is using the space.",
        })
        .meta({ floor: "maintainer" })
        .output(DiskPressureSchema),
    // Re-classifies every path right before removing it; one clean at a time, and it cancels a running scan first.
    cleanStorage: systemRoute
        .route({
            method: "POST",
            path: "/system/storage/clean",
            summary: "Free the space one category holds",
            description:
                "Removes what one cleanable category holds, and says how much space that gave back. Only what is old enough and not in use goes: today's logs, a browser that is open, the weights a running model reads and a pack still being written all stay. Nothing outside the sandbox's own volumes, and nothing a category may not hold, is ever removed. Categories that cannot be cleaned are refused.",
        })
        .input(StorageCleanInputSchema)
        .output(StorageCleanResultSchema),
    // One conversation's checkout at a time, by the rules the sweeps apply: the Storage card's per-conversation rows.
    pressCheckout: systemRoute
        .route({
            method: "POST",
            path: "/system/storage/checkouts/press",
            summary: "Free the space one conversation's checkout holds",
            description:
                "`cleanBuildOutput` removes the build output in one conversation's checkout, which its next build makes again. `release` commits what the checkout holds onto its branch and removes it and its overlay; the next turn brings them back. `trash` moves a checkout no conversation owns into the trash. Each is refused, with why, while the conversation's state forbids it: anything running in it, or work waiting that needs the checkout.",
        })
        .input(CheckoutPressInputSchema)
        .output(CheckoutPressResultSchema),
    // Control plane only; live I/O is /system/terminal WebSocket, exempt from the Bearer auth these routes take.
    terminals: systemRoute
        .route({
            method: "GET",
            path: "/system/terminals",
            summary: "Open terminals",
            description:
                "The terminal sessions this sandbox is holding, which is what a terminal panel rebuilds its tabs from after a reload. The live typing and output run over a separate socket; this is the list.",
        })
        // Lists tmux and the supervisor, neither built by the boot chain, for a surface on screen meanwhile.
        .meta({ beforeBoot: true })
        .output(TerminalsListSchema),
    killTerminal: systemRoute
        .route({
            method: "DELETE",
            path: "/system/terminals/{name}",
            summary: "Close a terminal",
            description: "Destroys one terminal session and whatever was running inside it.",
        })
        .input(TerminalNameParamSchema)
        .output(OkSchema),
    // Scrollback as selectable text; the live view is a tmux alternate screen, with nothing in the page to select.
    terminalScrollback: systemRoute
        .route({
            method: "GET",
            path: "/system/terminals/{name}/scrollback",
            summary: "A terminal's history as plain text",
            description:
                "What has scrolled past in one terminal, as text you can select and copy. The live view is a picture of a screen on the far side of a socket, with nothing in the page to select, so scrolling back and copying is this call rather than a gesture.",
        })
        .input(TerminalScrollbackQuerySchema)
        .output(TerminalScrollbackSchema),
    // Control plane like `terminals`; frames stream separately. `closeBrowser` fails the next call as crashed.
    browsers: systemRoute
        .route({
            method: "GET",
            path: "/system/browsers",
            summary: "Browsers the agent has open",
            description:
                "Every browser a conversation currently has running and the pages inside each one. The picture of what they are showing comes over a separate socket; this is the roster.",
        })
        .output(BrowsersListSchema),
    // The person's own window: started on the first call, given a new tab on every later one, never an agent's.
    openBrowser: systemRoute
        .route({
            method: "POST",
            path: "/system/browsers",
            summary: "Open a tab in your own browser",
            description:
                "Opens a tab in your own browser window, starting the window first when it is not running. It is a Chromium of its own, with a profile that keeps your sign-ins between windows, and no agent drives it. Answers once the window can be watched.",
        })
        .input(OpenBrowserInputSchema)
        .output(OpenBrowserResultSchema),
    closeBrowser: systemRoute
        .route({
            method: "DELETE",
            path: "/system/browsers/{name}",
            summary: "Shut a browser down",
            description:
                "Closes one of the agent's browsers. Its next attempt to use that browser then fails as though it had crashed, which is the honest account of somebody pulling the plug.",
        })
        .input(BrowserNameParamSchema)
        .output(OkSchema),
    // The rest of what a tab's own menu does, over the roster rather than a picture socket for the same reason as
    // closeBrowserPage: every window's tabs are on the strip, and only the one in front has a socket.
    reopenBrowserPage: systemRoute
        .route({
            method: "POST",
            path: "/system/browsers/{name}/closed",
            summary: "Reopen a closed tab",
            description:
                "Brings back a tab closed in a browser window that is still open, at the place it had, as a browser's own Reopen closed tab does. Without a tab named it is the one closed last. Answers the tab it opened.",
        })
        .input(ReopenBrowserPageInputSchema)
        .output(OpenBrowserResultSchema),
    moveBrowserPage: systemRoute
        .route({
            method: "POST",
            path: "/system/browsers/{name}/pages/{pageId}/move",
            summary: "Move a tab along its window's strip",
            description:
                "Puts one tab at another place in its window's order, the order every view of the window draws its tabs in and the order your own window reopens them in.",
        })
        .input(MoveBrowserPageInputSchema)
        .output(OkSchema),
    browserPageAction: systemRoute
        .route({
            method: "POST",
            path: "/system/browsers/{name}/pages/{pageId}/action",
            summary: "Reload, duplicate or mute a tab",
            description:
                "Does one thing to one tab of a browser window, whether or not it is the tab in front: reloads it, opens a copy of it beside it, or mutes or unmutes it. Answers the tab acted on, or the copy.",
        })
        .input(BrowserPageActionInputSchema)
        .output(OpenBrowserResultSchema),
    // One tab, closed without watching its window: the Browsers strip shows every window's tabs, and only the window in
    // front has a picture socket to say a close on.
    closeBrowserPage: systemRoute
        .route({
            method: "DELETE",
            path: "/system/browsers/{name}/pages/{pageId}",
            summary: "Close one tab of a browser",
            description:
                "Closes one tab of a browser window, as its own close button does. A tab that is already gone answers the same, since gone is what was asked for.",
        })
        .input(BrowserPageParamSchema)
        .output(OkSchema),
    // What the sandbox's browsers remember, one index per profile (schemas/browsing.ts): the address bar ranks it in the
    // editor on every keystroke, so it ships whole once and then only what changed, by cursor.
    browsingHistory: systemRoute
        .route({
            method: "GET",
            path: "/system/browsing/history",
            summary: "Where a browser has been",
            description:
                "The pages one of the sandbox's browsers has visited and the searches made in it, most worth suggesting first, for the address bar's suggestions and the history page. Hand back the cursor an answer gave to be told only what changed since. Each browser profile keeps its own: your own window's is `_own`, and nothing from an agent's browser is mixed into it.",
        })
        // Where the person went is theirs and the maintainers': a viewer reads the windows open, not their history.
        .meta({ floor: "maintainer" })
        .input(BrowsingHistoryQuerySchema)
        .output(BrowsingHistorySchema),
    forgetBrowsingHistory: systemRoute
        .route({
            method: "POST",
            path: "/system/browsing/history/forget",
            summary: "Forget part of a browser's history",
            description:
                "Removes pages from one browser profile's history: some addresses, everything visited in a stretch of time, or all of it. The address bar stops suggesting them at once. Chromium's own files inside the profile are not touched.",
        })
        .input(BrowsingForgetInputSchema)
        .output(BrowsingForgetResultSchema),
    // Fetched by the sandbox, so the engine sees the same address the browsing itself leaves from.
    searchSuggestions: systemRoute
        .route({
            method: "GET",
            path: "/system/browsing/suggest",
            summary: "What a search engine suggests for some text",
            description:
                "Asks the chosen search engine what it would suggest for text typed into the address bar, from the sandbox's own address like the browsing itself. Answers an empty list rather than an error when the engine is slow or unreachable, since the address bar has its own suggestions to show.",
        })
        .input(SearchSuggestQuerySchema)
        .output(SearchSuggestionsSchema),
    // The picture and the hands come over /system/desktop-view; this is whether there is anything on it, and which windows
    // a tab could show alone. Pushed through the `desktop` runtime domain as windows open, close and take the keyboard,
    // and as their titles change while a view is open; never polled by the client.
    desktop: systemRoute
        .route({
            method: "GET",
            path: "/system/desktop",
            summary: "The sandbox's own desktop",
            description:
                "Whether the sandbox's desktop is up, which display it is, and which windows are open on it. The live picture of it, or of one window on it, comes over a separate socket; this says whether there is anything to see.",
        })
        .output(DesktopStateSchema),
    // In-process and spawned alike: the board draws each under the card of the conversation that started it, and a chat
    // draws it on the card of the call that started it. Pushed through the `subagents` runtime domain, never polled. A
    // subagent's work is read where it lives: an in-process one's on its delegation's card in its parent's record, a
    // spawned one's in its own conversation (agents.transcript), so there is no second transcript door here.
    subagents: systemRoute
        .route({
            method: "GET",
            path: "/system/subagents",
            summary: "Subagents the agents have started",
            description:
                "Every subagent that conversations the caller can see have delegated work to, whichever tool started it, with what each one is doing: all that are still working, and the most recent that have settled.",
        })
        .output(SubagentsListSchema),
    // On the contract, not a hand-written route beside it: this payload is what every "do it out there" button is
    // gated on, so its shape has to be fingerprinted like any other, or a daemon older than the app disagrees about
    // it silently and the buttons just stop being drawn.
    devices: systemRoute
        .route({
            method: "GET",
            path: "/system/devices",
            summary: "The machines you have connected",
            description:
                "Every computer this sandbox can see, whether it reached it through desktop sync or through a connected device, in one row per machine: what it says about itself, which sandboxes it holds, and what stopped it answering when nothing came back.",
        })
        .output(DevicesListSchema),
    // (2026-11-22) The account's access map asks every sandbox it reaches for this one answer and joins them
    // (docs/architecture/accounts.md). Read from what the daemon stores and its live connections, never by calling a
    // machine, so a map of ten sandboxes costs ten cheap reads; only the link cards' terms ask the far sandbox, briefly.
    reach: systemRoute
        .route({
            method: "GET",
            path: "/system/reach",
            summary: "What this sandbox is tied to outside itself",
            description:
                "The other sandboxes this one hands work to and takes work from, with their terms; the computers, phones, browsers and servers its agents reach, with the switches each has on; whether it may create sandboxes on its owner's account; and, for each, whether the reader's own conversations may use it and how many other people's may. Shaped for the reader: inbound links and where it runs are Full access's, the counts of other people are for whoever runs people and access.",
        })
        .output(SandboxReachSchema),
    // One stream for every op; the daemon adds no judgment, a refusal is the machine's own `error` line.
    manageDeviceSandbox: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/sandboxes/{slug}",
            summary: "Drive a sandbox on one of your own devices",
            description:
                "Start, stop, restart, update, rebuild, roll back, reshape (its memory and CPU caps, privileged, GPU) or remove a sandbox running on a machine you own, relayed over the connection that machine holds open. The answer is a stream because the slowest of these takes minutes, and it is the same stream whichever you ask for. The daemon adds no opinion: the machine enforces its own permissions and a refusal arrives as the last line, in the machine's words, naming the switch to flip.",
        })
        .input(DeviceSandboxFlowInputSchema)
        .output(streamOf(DeviceFlowLineSchema)),
    // (2026-10-27) What a loosening of the egress fence is signed over: read just before the passkey ceremony, so the
    // editor hashes the very owner keys the daemon then hands the machine with `set-egress`.
    egressOwnerKeys: systemRoute
        .route({
            method: "GET",
            path: "/system/egress/owner-keys",
            summary: "The owner's passkeys a network-fence change is checked against",
            description:
                "The owner's passkeys (their public halves), the relying party and the exact origins a ceremony with them may run from, as this sandbox hands them to a machine with every change to a sandbox's network fence; whether the caller is the owner; and the exceptions this sandbox's own cards suggest (an SSH host, a network disk, a VPN gateway on a private network). The machine checks a loosening against the passkeys it pinned, so the editor signs over exactly these.",
        })
        .output(EgressOwnerKeysReadSchema),
    // Closed set of actions; the daemon builds the command line, not the caller. One sentence is the whole answer.
    runDeviceCommand: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/commands/{command}",
            summary: "Run one of your device's own CLI actions",
            description:
                "Performs a named action on a machine you own by running its own intentic-machine command there — turning that device's port mirroring off, say — over the connection it holds open. The set of actions is fixed and the command line is built here from the name, never sent by the caller. The machine enforces its own permissions and a refusal comes back as its own sentence, naming the switch to flip.",
        })
        .input(DeviceCommandInputSchema)
        .output(DeviceCommandResultSchema),
    // The stream usually ends without a frame; a bare stop means success, the device's version confirms it later.
    runDeviceAgentFlow: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/agent/{op}",
            summary: "Update, restart, or clean up the links of the agent on one of your own devices",
            description:
                "Updates a machine you own to the current intentic-machine agent, restarts the loop it is running, or drops the links it holds to sandboxes that have stopped answering — over the connection that machine holds open. The answer is a stream of the run's own output — and it normally stops mid-run, because the agent's loop is what carries this connection: the work is detached from it first, so it finishes regardless, and the device's reported version is what confirms it. Takes the machine's \"Run commands\" permission, the same one a command typed there would.",
        })
        .input(DeviceAgentFlowInputSchema)
        .output(streamOf(DeviceFlowLineSchema)),
    // Docker compose stacks on a connected computer (schemas/device-stacks.ts): what the Deployments board reads and
    // drives where no Komodo stands between. Relayed to the machine's own tools, which check its switches; the daemon
    // adds no opinion beyond the floor, so a refusal arrives in the machine's words, naming the switch to flip.
    deviceStacks: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/stacks",
            summary: "The Docker compose stacks on one of your devices",
            description:
                "Every Docker compose project on a computer you connected, with each service's container, image and state, and the folder this sandbox deploys stacks into there. Intentic's own sandboxes are marked rather than left out. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceStacksInputSchema)
        .output(DeviceStacksSchema),
    // Up, restart, start, stop, or pull-then-up; nothing here removes a stack or a volume.
    deviceStackOp: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/stacks/{name}/ops/{op}",
            summary: "Start, stop, restart or update a stack on one of your devices",
            description:
                "Runs `docker compose` for one stack on a computer you connected: `up` applies its files, `pull` fetches newer images and then applies, and `restart`, `start` and `stop` do what they say. Nothing here removes a stack or its volumes. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ panel: false })
        .input(DeviceStackOpInputSchema)
        .output(StackOpResultSchema),
    // Floored like the actions, though it only reads: a log can hold anything the service printed.
    deviceStackLogs: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/stacks/{name}/logs",
            summary: "The recent log of a stack on one of your devices",
            description: "The last lines every service of one compose stack printed, oldest first, as `docker compose logs` gives them.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceStackLogsInputSchema)
        .output(StackLogsSchema),
    // The repository's committed tree, packed here, carried over the device link and brought up there with `--build`.
    deployDeviceStack: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/stacks/{name}/deploy",
            summary: "Deploy a workspace repository to one of your devices",
            description:
                "Packs the committed tree (HEAD) of a workspace repository, carries it to a computer you connected and runs it there as a Docker compose stack of the given name, building its images on that computer. Uncommitted changes are not deployed. A `.env` already in the stack's folder there is kept: secrets are placed into it by an agent, never sent with a deploy. Needs that computer's \"Run commands\" and \"Run programs this sandbox sends\" switches.",
        })
        .meta({ panel: false })
        .input(DeviceStackDeployInputSchema)
        .output(DeviceStackDeployResultSchema),
};
