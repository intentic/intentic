// computers: what ONE of the user's own machines is running
import { z } from "zod";
import { HostFactsSchema } from "./hosts.js";
// The one sentinel every non-release build carries, so a locally compiled agent is never told it is behind.
import { DEV_VERSION } from "../versions.js";
/* The other end of desktop sync, stated as a fact instead of a claim.
 *
 * Everything here already existed, as the machine agent's printed status on a terminal nobody running the desktop app
 * has open, and as `docker ps` rows only the desktop app could see. Three surfaces each held a third of it: the
 * desktop app knew the containers and nothing about sync, the Desktop sync card knew an enrollment record and
 * printed the status command for the rest, and the folder a machine syncs into was known to neither
 * (SYNC_DIR is local agent state; the daemon is never told it). This is that one shape, so the same report can
 * be produced by the agent, read by the daemon, and rendered by one component in both apps.
 *
 * The producer is `intentic-machine status --json` in every carrier (this report rides as its `sync` half), the desktop app spawns it, the mirror watcher
 * posts it, a `host` capability runs it over run_command. One producer is what keeps the three from drifting,
 * the same argument as the desktop app spawning connect.sh rather than reimplementing it.
 *
 * WHO FILLS WHAT is the disclosure rule, made structural. The agent reports only what it uniquely knows, its
 * own pairings, folders, ports, watcher, and NEVER `sandboxes`: enumerating a machine's other containers to one
 * of them is the leak this design exists to avoid, and a sync agent has no business doing it anyway. The docker
 * half is supplied by whoever is READING (the desktop app from its own `docker ps`, the daemon from a
 * `host`-capability one), which is also the only side that has a reason to be trusted with it.
 *
 * What remains is scoping: a report reaching a sandbox carries that sandbox's pairing, not its siblings', and a
 * `mirror` enrollment, a collaborator's own laptop, drops `localDir` with it. So a member who mirrors one
 * dev-server port does not hand the sandbox's owner a map of their machine. */

// One sandbox container on the machine, the docker half, filled in by the reader, never by the sync agent.
export const MachineSandboxSchema = z.object({
    slug: z.string(),
    container: z.string(),
    // The display name, when the machine has one recorded. Docker knows only the container name.
    name: z.string().optional(),
    running: z.boolean(),
    image: z.string(),
    // Absent when the sandbox has no cloudflared sidecar AT ALL (reached over the user's own proxy), which is
    // not the same fact as a sidecar that is down, and must not render as one.
    tunnelRunning: z.boolean().optional(),
});
export type MachineSandbox = z.infer<typeof MachineSandboxSchema>;
/* ONE OPERATION ON ONE SANDBOX ON ONE MACHINE, the Computers view's buttons, and the only thing that changes a
 * machine's fleet from a browser.
 *
 * All nine ops travel one route because they are one decision to the person clicking, however differently they
 * behave underneath: three are a docker call that returns in a second, four run the `ic` flow for minutes, one
 * deletes, and one only reads. Splitting them by duration would put the same button on two doors and give the
 * view two shapes to render. So every op answers as a STREAM of lines ending in a result, the fast ones simply
 * have little to say, and `logs` is the case where the lines ARE the answer.
 *
 * `prepare` is the one that changes nothing on purpose: it downloads and builds the next update and stops
 * there, leaving the container running the image it was already running. It is what turns `update` from a wait
 * of minutes into a restart of seconds, and it is safe to offer at any moment for exactly that reason.
 *
 * `logs` is here rather than on a route of its own for the same reason the rest share it: it is a button in the
 * same row as the others, on a container that may be too broken to answer any other way, and the stream shape
 * already carries "many lines, then an outcome" exactly as a log tail wants to arrive.
 *
 * The machine enforces which of them it will do: `sandboxes` covers everything but removal, which takes its own
 * switch, and a refusal comes back as the machine's own sentence naming the control to flip. */
/* `runner-up` / `runner-remove` are the same door for a container that belongs to THIS SANDBOX rather than to
 * a person: a runner (runners/, docs/remote-runners-plan.md at the workspace root). They ride here because to
 * the machine they are the same act it already does, run and remove a sandbox container, and to the person
 * clicking they are the same row of buttons. Both take the `sandboxes` switch and neither takes the removal
 * one: a runner holds no workspace of its own, only a mirror of the parent's git, so removing it destroys
 * nothing the parent does not still have. */
export const MachineSandboxOpSchema = z.enum([
    "start",
    "stop",
    "restart",
    "prepare",
    "update",
    "rebuild",
    "rollback",
    "remove",
    "logs",
    "runner-up",
    "runner-remove",
]);
export type MachineSandboxOp = z.infer<typeof MachineSandboxOpSchema>;
export const MachineSandboxFlowSchema = z.object({
    op: MachineSandboxOpSchema,
    // Which sandbox, or, for the two runner ops, which RUNNER: the name it is known by at both ends, the
    // parent's `/system/runners` list and the machine's `ic runner list`.
    slug: z.string().min(1),
    // The approved overlay's sha256, required by `rebuild` and meaningless to the rest. It is the trust anchor:
    // only content that still hashes to what the owner reviewed is ever built.
    hash: z.string().optional(),
    /* `runner-up` only, and both are filled in by the DAEMON, never by the caller: where the runner dials
     * (this sandbox's public URL) and the single-use pairing it redeems there. The browser asks for a runner
     * on a machine; it never holds the credential that makes one, which is what keeps a pairing out of every
     * surface between here and that machine. */
    parentUrl: z.string().optional(),
    pair: z.string().optional().meta({ secret: true }),
    /* `runner-up` only, daemon-filled like the pair: the parent's SHAPE, riding to the machine so the runner
     * starts as this sandbox's twin instead of a bare base image.
     *
     * `definition` is a settings-only sandbox.toml the container boots with as SANDBOX_DEFINITION_SEED (the
     * fleet door in @intentic/sandbox-run); the daemon scopes it before sending, capabilities and secret
     * names deliberately never ride to a runner. `overlay`/`overlayHash` are the parent's APPROVED composed
     * overlay, byte-exact with its sha256: the parent's owner already approved those bytes, so `ic runner up`
     * re-checks the hash and builds them at creation — approval by provenance, the same byte-exact check
     * `ic sandbox rebuild` runs, where a definition handed to a STRANGER must park at an approval gate. */
    definition: z.string().optional(),
    overlay: z.string().optional(),
    overlayHash: z.string().optional(),
});
export type MachineSandboxFlow = z.infer<typeof MachineSandboxFlowSchema>;
// The same input plus which machine it is for, the browser's half, since the daemon reaches the machine by id.
export const MachineSandboxFlowInputSchema = MachineSandboxFlowSchema.extend({ id: z.string().min(1) });
export type MachineSandboxFlowInput = z.infer<typeof MachineSandboxFlowInputSchema>;
/* What a running operation says, in the one line shape every streamed flow in this product already uses
 * (IntenticLineSchema, which the browser's reader parses): `line` as the machine prints it, then exactly one
 * terminal frame, `result` when it worked, `error` when it did not, carrying the machine's own words either
 * way rather than a code this side invented. */
export const MachineFlowLineSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("line"), text: z.string() }),
    z.object({ kind: z.literal("result"), message: z.string() }),
    z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type MachineFlowLine = z.infer<typeof MachineFlowLineSchema>;
/* RUNNING ONE OF THIS PRODUCT'S OWN CLIs ON A CONNECTED COMPUTER, FROM A BUTTON, with no agent in the loop.
 *
 * A machine that is connected as a computer can already be told things: the ops above drive its docker, and an
 * agent with the `host` capability can run whatever it likes through `run_command`. What had no door was the
 * ordinary case in between — the user wants the thing the CLI on their machine already does, and the sandbox is
 * where they are looking. Their alternatives were to go and find a terminal, or to ask an agent to do it, which
 * spends a turn and a model's judgement on a decision that has none in it.
 *
 * So: a CLOSED SET OF NAMES, and the argv is built on the daemon from the name alone (hosts/machine-commands.ts).
 * The browser sends `mirror-off`, never a command line. That is the whole security property, and it is the
 * reason this is an enum rather than a string: the same socket carries `run_command`, so a route that forwarded
 * caller-supplied text would hand every browser session a shell on the user's laptop, which is a grant the
 * capability card never made.
 *
 * The machine still enforces its own switches. "Run commands" being off comes back as its own refusal, in its
 * own words, naming the control to flip — exactly as it does for the sandbox ops. */
/* THE SET, and why the file-sync half of it is here beside the mirroring half.
 *
 * Both are the same gesture to the person clicking: something this computer is doing for this sandbox, turned
 * off or on from the row that describes it. They were split for a while by nothing but which one had been built
 * — mirroring had a button and pausing a file sync had a paragraph telling you to go and find a terminal — and
 * that is exactly the gap this door exists to close.
 *
 * `sync-unpair` is the one that DESTROYS something, and it is deliberately the machine's `sync uninstall
 * --sandbox`, not this side's idea of unpairing: the agent terminates both Mutagen sessions, drops the local
 * pairing and self-revokes its enrollment on the way out, so the machine cleans up after itself rather than
 * leaving a sandbox to guess what it managed to do. Revoking from the SANDBOX side (an unreachable machine, a
 * laptop that is never coming back) is a different act and a different route, see the enrollment revoke. */
export const MachineCommandSchema = z.enum(["mirror-off", "mirror-on", "sync-pause", "sync-resume", "sync-unpair"]);
export type MachineCommand = z.infer<typeof MachineCommandSchema>;
/* Which paired sandbox the command acts on: the machine's own id for it, as it appears in that machine's report,
 * so nothing here has to re-derive the sanitizing the agent applied. Absent means every sandbox that machine
 * pairs, which is what the CLI does when it is run bare.
 *
 * Pattern-bound because it becomes an argv token. It must start with an alphanumeric, not merely consist of id
 * characters: a value like `--takeover` is made only of legal id characters and is a FLAG by the time the CLI on
 * the machine parses it. Real ids are `sandbox-<hex>-<zone>`-shaped, so nothing legitimate leads with a dash. */
export const MachineSandboxIdSchema = z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const MachineCommandInputSchema = z.object({
    id: z.string().min(1),
    command: MachineCommandSchema,
    sandboxId: MachineSandboxIdSchema.optional(),
});
export type MachineCommandInput = z.infer<typeof MachineCommandInputSchema>;
/* What came back. `ok` is the command's own exit status, not this route's: a machine that refused the call, or a
 * CLI that exited non-zero, is a real answer to show the person who clicked, not an exception to convert into
 * one. Only an unreachable machine throws, because then there is nothing to report at all.
 *
 * `output` is what the command printed, kept because the CLI's own sentences ("Port mirroring OFF for: …") are
 * better than anything this side would write over them. */
export const MachineCommandResultSchema = z.object({
    ok: z.boolean(),
    message: z.string(),
    output: z.string().optional(),
});
export type MachineCommandResult = z.infer<typeof MachineCommandResultSchema>;
// One paired sandbox as the local agent holds it. `localDir` is the answer to the question the Desktop sync card
// has never been able to answer: which folder on that computer this sandbox's /work actually is.
export const MachinePairingSchema = z.object({
    sandboxId: z.string(),
    mode: z.enum(["sync", "mirror"]),
    // Set only for mode "sync", and only for the sandbox being reported to, see the redaction note above.
    localDir: z.string().optional(),
    /* Whether that computer is putting this sandbox's ports on its own localhost, which is a switch its owner
     * holds and not a state this sandbox can read off anything else. An empty port list means two opposite
     * things — nothing is listening in the sandbox, or the machine was told to keep them off — and only the
     * second is worth a word on screen or a button to undo.
     *
     * The MACHINE owns the flag (the agent's `sync mirror off`), because the localhost being written to is
     * there: a computer told to keep ports off must keep them off while this sandbox is asleep, unreachable, or
     * arguing. A browser asks for it by running that same command over the machine's `host` capability, so the
     * button and the CLI are one gesture rather than two mechanisms that can disagree.
     *
     * Optional because it is a fact only an agent new enough to have the switch reports; absent is read as "on",
     * which is what mirroring has always been. */
    mirroring: z.enum(["on", "off"]).optional(),
    // Mutagen's own word for what the session is doing ("watching", "scanning", "transitioning", "halted-…").
    // Carried verbatim rather than mapped to a traffic light: the halted states name their own cause, and a UI
    // that reduces them to "problem" sends the user back to the terminal this report exists to replace.
    mutagenStatus: z.string().optional(),
    // Conflicts Mutagen is holding rather than clobbering (the sync mode is two-way-SAFE). Nothing else in the
    // product surfaces these, so a file edited on both ends stays stuck until someone runs the CLI.
    conflicts: z.number().int().nonnegative().optional(),
    paused: z.boolean().optional(),
    /* The SECOND session's word, the one-way mirror carrying the sandbox's state dir down (sync's backupSpec).
     * Reported separately rather than folded into the status above, because the two fail independently and mean
     * different things: the first going quiet stops the owner's edits moving, the second going quiet stops their
     * personas, skills, automations, approvals and transcripts from surviving the sandbox. A backup that is not
     * running is only dangerous while nobody knows, so it gets its own word on the line. */
    backupStatus: z.string().optional(),
});
export type MachinePairing = z.infer<typeof MachinePairingSchema>;
/* One sandbox port and what became of it on this machine's localhost. The rows that did NOT make it are the
 * reason this carries a state rather than being a list of live forwards: two sandboxes on one computer routinely
 * serve the same dev-server port and only one can own localhost:6480, so the loser's port is simply missing from
 * localhost with nothing anywhere saying why. Today that fact exists only as a line in mirror.log. */
export const MachinePortStateSchema = z.enum([
    // Forwarded: the sandbox's listener answers on this machine's localhost at the same number.
    "mirrored",
    // Another PAIRED SANDBOX got there first (first paired wins), `heldBy` names it, because "busy on this
    // machine" sends people hunting for a process that does not exist.
    "held-by-sandbox",
    // Something else on this computer already binds the port, a local dev server, another tool. Not ours to
    // name, and not ours to take.
    "busy",
]);
export const MachinePortSchema = z.object({
    port: z.number().int().min(1).max(65535),
    host: z.enum(["127.0.0.1", "::1"]),
    // The sandbox serving the port, whose /ports listed it, not whoever ended up holding the local bind.
    sandboxId: z.string(),
    state: MachinePortStateSchema,
    // Set only for "held-by-sandbox": the sandbox id that owns the local bind instead.
    heldBy: z.string().optional(),
    // What is listening on the sandbox side ("node …/vite"), for a row the user has to recognise to act on.
    command: z.string().optional(),
});
export type MachinePort = z.infer<typeof MachinePortSchema>;
/* The resident watcher's liveness. This is the field that decides whether everything ELSE in the report is still
 * true: a healthy session list under a dead watcher means new dev-server ports stop appearing on localhost and
 * commits stop arriving in the local clones, while every other row keeps reading exactly as it did. */
export const MachineWatcherSchema = z.object({
    running: z.boolean(),
    pid: z.number().int().optional(),
    /* WHICH BUILD IS ACTUALLY SERVING, stamped into the pidfile by the loop that claimed it, which is the only
     * place the fact exists: replacing the binary does not touch the running process, so a machine can hold a
     * current agent and go on serving a months-old one indefinitely. `agents.sync` is the file, this is the
     * process, and the two differing is a restart somebody is owed (see watcherBuildSkew). Absent when no loop
     * is running, and when the one running predates the stamp. */
    build: z.string().optional(),
    /* When the watcher last FINISHED a pass, the field that makes `running` mean something. The agent holds its
     * SSH transport listeners on its own event loop, so a failure that escapes the loop leaves a process that is
     * alive and a loop that is gone: pid present, unit "active", mirroring and the git bridge stopped. Absent
     * means the agent has not reported one (too old to stamp, or its first pass has not landed), which is not
     * the same as stalled, and readers must not treat it as either state. */
    lastTickAt: z.number().optional(),
});
export type MachineWatcher = z.infer<typeof MachineWatcherSchema>;
/* How long a watcher may go without finishing a pass before "running" stops being the honest word for it. Its
 * loop polls every 5s and its slowest step is bounded by two 10s network timeouts per pairing, so a minute is
 * several passes of slack, the same yardstick the Computers view already ages a whole report by.
 *
 * The rule lives HERE, next to the field, because the terminal and the browser both answer this question and a
 * machine that is "running" in one and "stalled" in the other is worse than either answer alone. */
export const WATCHER_STALL_AFTER_MS = 60_000;
export const watcherStalled = (watcher: MachineWatcher, now: number): boolean =>
    watcher.running && watcher.lastTickAt !== undefined && now - watcher.lastTickAt > WATCHER_STALL_AFTER_MS;
export const MachineReportSchema = z.object({
    /* The OS hostname, and the JOIN KEY. A machine can arrive here two ways at once, volunteered by its sync
     * agent, and read through its `host` capability, and those two know it by different names (the enrolled
     * key's comment vs. the capability id the user typed). The hostname is the one thing both can state about
     * the same box, so it is what dedupes them into a single row. */
    hostname: z.string(),
    os: z.string(),
    /* Which agents this machine has, and at what version, so one on an old build is visible rather than
     * mysteriously lacking a field. Same argument as HostSummary.version.
     *
     * `sync` is the agent INSTALLED here — the file on disk — and `watcher.build` beside it is the loop running
     * from that file. It used to be neither: whichever process happened to build the report stamped its own
     * version here, so the same machine answered its running build to a sandbox its loop posted to and its
     * installed build to one that ran `status --json` over a host capability. One field, two meanings, and the
     * gap between them — a machine updated but never restarted — invisible in both.
     *
     * `host` is what the live socket announced (so: what is running), filled by the daemon at merge time from
     * the hello frame it already holds, never by the sync agent, which would have to go reading another agent's
     * config to guess at it. */
    agents: z.object({ sync: z.string().optional(), host: z.string().optional() }),
    // Filled by the READER, never the agent (see above). Empty is the resting state: no Docker on the machine,
    // or nothing has looked. Neither is an error, and neither means "no sandboxes exist".
    sandboxes: z.array(MachineSandboxSchema),
    pairings: z.array(MachinePairingSchema),
    ports: z.array(MachinePortSchema),
    watcher: MachineWatcherSchema,
    // When the machine took this reading. NOT when the daemon received it. A report is a snapshot from a box
    // that may since have gone to sleep, and the UI ages it against this rather than presenting it as now.
    capturedAt: z.number(),
});
export type MachineReport = z.infer<typeof MachineReportSchema>;

/* THE AGENT THIS MACHINE INSTALLED AND THE ONE IT IS RUNNING, when they are not the same build — the whole of
 * "you updated the agent and nothing changed", as a value.
 *
 * It is one comparison, and it lives HERE for the same reason watcherStalled does: the terminal (`intentic-machine
 * status`) and the browser (the Computers row) both answer this question, and a machine that is behind in one and
 * fine in the other is worse than either answer alone. The remedy is the same in both: restart the loop.
 *
 * AN UNSTAMPED LOOP IS THE LOUDEST CASE, not a missing one, and reading it as "nothing to say" is what let this
 * whole check miss the machines it was written for. `watcher.build` is stamped into the pidfile by the loop that
 * claimed it, so a loop old enough to predate the stamp reports none — and it is running, and something newer is
 * installed beside it, which is a skew by definition and a wider one than any it could have named. Every surface
 * therefore went quiet on precisely the machines furthest behind: upgrade, see the new number everywhere, watch
 * nothing change, and have no screen anywhere say why.
 *
 * So the running build is OPTIONAL in the answer and the question is asked of the installed one. Still silent
 * whenever the honest answer is "no idea": a loop that is stopped (nothing is serving, and every surface already
 * says so in louder words), a machine with no installed agent to compare against, and a working-tree build, which
 * is not a version and must not be told it is behind. */
export const watcherBuildSkew = (report: MachineReport): { readonly running: string | undefined; readonly installed: string } | undefined => {
    const running = report.watcher.build;
    const installed = report.agents.sync;
    if (!report.watcher.running || installed === undefined || installed === DEV_VERSION || running === installed) {
        return undefined;
    }
    return { running, installed };
};

// Why a computer that is plainly THERE has no report to show. Each is a different errand for the reader, which is
// the whole reason they are not collapsed into one "unavailable".
export const ComputerGapSchema = z.enum([
    // A host capability that is enrolled but has no socket right now. Laptops sleep; this is not a fault.
    "offline",
    // Connected, but "Run commands" is switched off on its capability card, so the daemon may not ask it
    // anything. The one gap the user can close in a single click, and the UI says which switch.
    "scope-off",
    // Reachable, asked, but has no `intentic-machine` on it, so nothing knows about folders or mirrored ports there.
    "no-agent",
    // A sync-enrolled machine that has not posted a report yet: either it just enrolled, or its agent predates
    // machine reports. Distinct from "no-agent" because the agent IS there and the folders ARE syncing.
    "unreported",
]);
export type ComputerGap = z.infer<typeof ComputerGapSchema>;
/* ONE COMPUTER, however the sandbox happens to be able to see it, and it may be both ways at once.
 *
 * A machine reaches a sandbox through two independent doors: a desktop-sync enrollment (which volunteers its own
 * report) and a `host` capability (which the daemon can ask). They know the same box by different names, the
 * enrolled ssh key's comment vs. the capability id the user typed, so the two are reconciled on the `hostname`
 * their reports agree on, and left as separate rows when there is nothing to reconcile them by. Guessing that two
 * differently-named machines are the same one would merge two people's laptops on a shared sandbox. */
/* THE DESKTOP-SYNC ENROLLMENT BEHIND A ROW, which used to be a boolean and could not be.
 *
 * `syncEnrolled: true` answered "is this machine paired" and nothing a reader standing in front of the row
 * actually asks next: WHICH half of desktop sync it holds (files and ports, or ports alone), whether it has
 * ever used the enrollment, and how to name it when they want it gone. Those three lived on /system/sync
 * instead, as one machine's worth of `syncingFrom` plus a list of `mirroredBy` names, which is the sandbox-level
 * shape this view exists to stop being: one card claiming a sandbox has A desktop sync, over a list of the
 * several computers that actually do.
 *
 * `machine` is the enrollment's own name for the box (the ssh key's comment). It is what the reports are filed
 * under, and it is the id the revoke route takes — the same string, so a row can revoke exactly the enrollment
 * it is drawn from. Two machines that present the same comment share one enrollment identity throughout the
 * daemon (reports included); that is a pre-existing property of naming machines by their key comment, and this
 * field inherits it rather than inventing a second identity that would disagree with the first. */
export const ComputerSyncSchema = z.object({
    machine: z.string(),
    /* Which half. "sync" is files AND ports and is SINGLE-HOLDER for the sandbox; "mirror" is ports only and any
     * number of machines may hold one. The row says which, because "your laptop is paired" is read as the first
     * by somebody who has the second, and then their files are not where they expect them. */
    mode: z.enum(["sync", "mirror"]),
    // When this machine last USED its enrollment (its watcher's own polls stamp it). Absent on one that never
    // has, which is exactly what a setup that did not finish leaves behind, and must not read as healthy.
    seenAt: z.number().optional(),
});
export type ComputerSync = z.infer<typeof ComputerSyncSchema>;
export const ComputerSchema = z.object({
    // Stable row key: the reported hostname when either door produced one, else the name that door knows it by.
    key: z.string(),
    // What to call it on screen, the user's own name for the machine wherever one exists.
    label: z.string(),
    // The desktop-sync enrollment this machine holds with this sandbox, absent when it has none (a computer
    // reached only through its `host` capability).
    sync: ComputerSyncSchema.optional(),
    // The host capability's id, when this machine is also a connected computer. Absent otherwise.
    hostId: z.string().optional(),
    // Host-capability liveness. Absent when there is no host capability, which is NOT the same as offline.
    online: z.boolean().optional(),
    /* WHAT THE COMPUTER IS, as distinct from how it is reachable, the half a row used to leave out entirely,
     * so a Windows laptop and a Linux desktop were two identical lines of text with different names on them.
     *
     * It is carried BESIDE the report rather than inside it because the rows that need it most are the ones with
     * no report: a connected computer with no sync agent, or one that is asleep, still knows its own OS. Nothing
     * here depends on an agent being installed, and the daemon has held all of it since the machine connected.
     *
     * `platform` is the slug this side classifies the machine by, the host capability's own card ("windows",
     * "linux"), or the platform token a sync report carries, normalised to the same words. `facts` is the
     * machine's connect-time description of ITSELF, which is what says which Windows and which shell. */
    platform: z.string().optional(),
    facts: HostFactsSchema.optional(),
    // The host agent's version and when the machine last held a socket, how a connected computer AGES. An old
    // agent explains a row that lacks something newer machines have, and "last seen" is the one honest thing an
    // offline row can still say about itself.
    hostAgent: z.string().optional(),
    lastSeen: z.number().optional(),
    report: MachineReportSchema.optional(),
    gap: ComputerGapSchema.optional(),
});
export type Computer = z.infer<typeof ComputerSchema>;
export const ComputersListSchema = z.object({ computers: z.array(ComputerSchema) });
/* GET /system/sync: what desktop sync is doing for this sandbox, WITHOUT naming any one machine as the answer.
 *
 * It used to carry `syncingFrom` + `syncSeenAt` + `mirroredBy`, which is the enrollment list flattened into one
 * holder and a list of everybody else — the shape a card that believed a sandbox has A desktop sync needed, and
 * the reason that card kept restating facts the Computers list beside it already had per machine. Every one of
 * those now rides on the machine's own row (ComputerSync), where a reader can act on it.
 *
 * What is left is what is genuinely about the SANDBOX rather than about any computer: whether sync is possible
 * here at all, whether anything at all is enrolled, and the raw reports, which is the cheap ambient read the
 * rail's badge lives on (it must never fan out to somebody's laptop just to decide whether to draw a chip). */
export const SyncStatusSchema = z.object({
    enrolled: z.boolean(),
    /* Whether this sandbox can do desktop sync at all. It used to be the SSH hostname the laptop would dial, and
     * its absence meant "this sandbox's reachability can't carry SSH", true of every sandbox on the platform's
     * own fabric, which is what made sync fail on the default path. The transport rides the daemon's own HTTPS
     * surface now, so a sandbox that can answer this read can also sync. Kept as a field rather than assumed,
     * because the card branches on it and a daemon too old to say is one that should not be offered sync. */
    available: z.boolean().optional(),
    machines: z.array(MachineReportSchema).optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
