import { installScriptUrl } from "@intentic/constants";
import type { Capability, Device, DeviceCommand, DeviceCommandInput, DeviceCommandResult, HostFacts } from "@intentic/sandbox-contract";

import {
    DEV_REBUILD_EXIT_MARK,
    DEV_REBUILD_QUIET_MARK,
    devRebuildLogPath,
    HOST_NATIVE_ENVIRONMENT,
    hostCardOf,
    hostConnectionKey,
    hostEnvironmentOf,
    pathReach,
} from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { callTool, forgetPull, heldHostDevices } from "./device-reports.js";
import { ownSlug } from "./self-host.js";

// This product's own CLI, run from a button on a device the user connected. The set of actions is closed and the
// command line is built here: what reaches the argv is a NAME from the contract's enum, a pattern-bounded sandbox id
// or folder, and values only the daemon holds (the dev checkout this container records, a pairing minted for the one
// call). Not a general remote-execution surface; the machine still refuses via its own switch.

// This side's timeout exceeds the machine's own budget, so an overrun surfaces as its answer, not a cutoff.
export const COMMAND_TIMEOUT_MS = 20_000;
// A build (dev-reload) or an install that fetches Mutagen and cloudflared (sync-install) is minutes, not seconds; the
// machine's own ceiling is ten minutes, and the hub's connection ceiling is above that.
const LONG_COMMAND_TIMEOUT_MS = 8 * 60_000;
// READING THE REBUILD LOG IS A `stat` AND A `tail` AND STILL NEEDS THIS. What costs is getting there — a login shell,
// and on a PC a `wsl.exe` session on top of it — on the one machine guaranteed to be flat out, because the build being
// read about is what is loading it. Unlike the launch beside it, this is the command whose answer nobody waits on: it
// is polled every few seconds for the length of a build, so its budget buys a truthful reading rather than a wait.
// Measured on a rebuild at load 19.5, the 20s default was killed mid-poll while the build carried on to exit 0.
const UNDER_LOAD_TIMEOUT_MS = 60_000;
// Slack over the machine's own budget, whichever budget the command chose.
const CALL_SLACK_MS = 5_000;

// What the daemon knows when it fills in a command line. Only `sandboxId` and `localDir` come from the caller, both
// pattern-bounded by the contract; the rest is this sandbox's own knowledge of itself and of the machine it is talking
// to, which is the whole reason these lines are built here rather than sent by a browser.
export interface DeviceCommandFacts {
    readonly sandboxId: string | undefined;
    readonly ownSlug: string | undefined;
    readonly devRoot: string | undefined;
    readonly publicUrl: string;
    readonly platform: string | undefined;
    // That door's connect-time self-description, which is what says whether a Windows PC has a distro to cross into
    // and whether its agent is new enough to be asked (`wslDistros`). Absent for a card that has never connected.
    readonly hostFacts: HostFacts | undefined;
    readonly mode: "sync" | "mirror" | undefined;
    readonly localDir: string | undefined;
    // The folder of the pairing a sync switch acts on, from readings already held. Which environment of that computer
    // runs mutagen for it is decided by where that folder is, so this is what routes the switch.
    readonly pairedDir: string | undefined;
    // This machine's connections holding a socket right now, by environment key. An environment with its own agent is
    // talked to directly; one without is reached by crossing from the door that is open.
    readonly connections: readonly string[];
    /** Minted for this one call, and only for a command whose spec asks for one. */
    readonly pairToken: string | undefined;
}

// Where this command will run, once the route is known: the environment it lands in decides the dialect a line is
// written in, which is why the route is computed before the line rather than after.
export interface DeviceCommandRoute {
    /** The environment the line runs in (`native`, `wsl:<distro>`); absent for a command that names no path. */
    readonly environment?: string;
    // That environment's OWN connection of this machine, when it holds a socket: one hop fewer than crossing, its own
    // login shell, and no `wsl.exe` session to be torn down under a detached build.
    readonly connection?: string;
    /** `run_command`'s crossing, for an environment of that computer with no agent of its own. */
    readonly in?: string;
    /** Why nothing of that computer can run it; the line is never built when this is set. */
    readonly refusal?: string;
}

interface DeviceCommandSpec {
    /** What the action did, in this side's words, for the case where the CLI itself printed nothing. */
    readonly done: string;
    // The command line, or undefined when this sandbox cannot form one; `needs` then says what is missing, since
    // "no line" is a fact about where this sandbox runs rather than a failure on the device.
    // Takes the route because a crossed command lands in another shell: `sync-install` writes PowerShell for the
    // Windows side and sh for a distro, and which of those it is follows the folder, not the door. An absent route
    // means the line runs in the door's own shell, which is every command that names no path.
    readonly line: (facts: DeviceCommandFacts, route?: DeviceCommandRoute) => string | undefined;
    /** Why a command could not be formed here, in the refusal's own words. */
    readonly needs?: string;
    // True when the command refuses to run fleet-wide and needs a sandbox id; only the destructive action sets it.
    readonly scoped?: boolean;
    /** Above the 20s default for a command that downloads, builds, or has to reach a machine busy doing one. */
    readonly timeoutMs?: number;
    /** Mints a single-use desktop-sync pairing for this call; only the enrolling command asks. */
    readonly mints?: boolean;
    // The path on the device this line is written for, when it has one. Only the environment holding that path can
    // run the line, and a PC answers for its containers through every door on it, so the door that reports this
    // sandbox is not yet the door that can `cd` into its checkout.
    readonly path?: (facts: DeviceCommandFacts) => string | undefined;
}

// With an id, acts on one paired sandbox; bare, acts on every sandbox the device pairs. Only the reversible verbs offer
// the bare form; sync-unpair is scoped and refused without an id.
const forSandbox = (base: string, sandboxId: string | undefined): string => (sandboxId === undefined ? base : `${base} --sandbox ${sandboxId}`);

// A leading `~` is expanded by the shell only outside quotes, so the daemon writes `$HOME` itself: the contract's own
// schema refuses a `$` from the caller, which makes this the only one in the line.
const shellDir = (dir: string): string => `"${dir.replace(/^~(?=[\\/]|$)/, "$HOME")}"`;

// BOTH DEV COMMANDS NEED pnpm, AND THE AGENT'S SHELL USUALLY HASN'T GOT IT. Its installer writes PNPM_HOME into the
// INTERACTIVE rc (.zshrc/.bashrc); the agent runs a login shell, which never reads those, so a line that just says
// `pnpm` dies with "command not found" on a machine where the owner's own terminal runs it fine. Prepended rather than
// substituted: a PATH that already has pnpm keeps winning, and a machine that keeps it elsewhere is unaffected.
const WITH_PNPM = 'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"; export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH";';

// WHAT MAKES A DETACHED BUILD OUTLIVE A CROSSED CALL. `in: "wsl:<distro>"` runs as `wsl.exe --exec sh -lc <script>`,
// and WSL tears that session down as it exits. Measured on a real one: `nohup` alone does not save a pnpm/node tree —
// it died the instant the build phase ended, leaving no exit mark and a card that span forever — and a session of its
// own does. Resolved rather than spelled, so a machine without `setsid` (macOS) expands it to nothing and keeps the
// shape that has always worked there.
const OWN_SESSION = "detach=$(command -v setsid 2>/dev/null || true);";

// The install one-liner for this sandbox, in the dialect of the environment it will RUN in — the same script,
// environment and single-use token the card's copyable command carries, built from the same table
// (@intentic/constants). The folder is what picks that environment (`doorRoute`), so a folder in a distro gets the sh
// form inside that distro even when the door is the PC's Windows side.
const installLine = (facts: DeviceCommandFacts, route: DeviceCommandRoute = {}): string | undefined => {
    if (facts.pairToken === undefined || facts.publicUrl === "") {
        return undefined;
    }
    // Mirror enrollments carry no folder at all: they forward ports and touch no files.
    const dir = facts.mode === "mirror" ? undefined : facts.localDir;
    const windowsTarget = route.environment === undefined ? facts.platform === "windows" : route.environment === HOST_NATIVE_ENVIRONMENT;
    if (windowsTarget) {
        const env = `$env:SANDBOX_URL='${facts.publicUrl}'; $env:PAIR_TOKEN='${facts.pairToken}';${
            dir === undefined ? "" : ` $env:SYNC_DIR=${shellDir(dir)};`
        }`;
        return `${env} irm ${installScriptUrl("desktopPs1")} | iex`;
    }
    const env = `env SANDBOX_URL='${facts.publicUrl}' PAIR_TOKEN='${facts.pairToken}'${dir === undefined ? "" : ` SYNC_DIR=${shellDir(dir)}`}`;
    return `curl -fsSL ${installScriptUrl("desktopSh")} | ${env} sh`;
};

// EVERY SWITCH OVER AN EXISTING PAIRING GOES WHERE ITS FOLDER IS. One agent per OS install holds the mutagen session
// it started, so `intentic-machine sync …` only reaches it in that environment — and the folder the pairing reports is
// what says which. A ports-only enrollment has no folder and stays on the side the card is named after, which is
// where its forwarder runs.
const pairedFolder = (facts: DeviceCommandFacts): string | undefined => facts.pairedDir;

export const DEVICE_COMMANDS: Readonly<Record<DeviceCommand, DeviceCommandSpec>> = {
    "mirror-off": {
        done: "Port mirroring is off on that device. File syncing is untouched.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync mirror off", sandboxId),
        path: pairedFolder,
    },
    "mirror-on": {
        done: "Port mirroring is back on. Ports return to that device's localhost within a few seconds.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync mirror on", sandboxId),
        path: pairedFolder,
    },
    // Pausing sync also pauses the workspace's state backup, so it never writes into a folder mid-pause.
    "sync-pause": {
        done: "File syncing is paused on that device. Its ports keep being mirrored.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync pause", sandboxId),
        path: pairedFolder,
    },
    "sync-resume": {
        done: "File syncing has resumed on that device.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync resume", sandboxId),
        path: pairedFolder,
    },
    // Removes ONLY what the session already ignores — build output sitting inside directories this sandbox deleted,
    // which is what stops those deletions from ever reaching the device. Safe enough to be a button precisely because
    // it can destroy nothing sync would have carried; a conflict with two real copies is left for `Fix with agent`.
    "sync-clean": {
        done: "Cleared the build output that was holding this sandbox's deletions back. Syncing resumes on its own within a few seconds.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync clean", sandboxId),
        path: pairedFolder,
    },
    // Uninstall ends both sync sessions and self-revokes enrollment; the sandbox and local folder are untouched.
    "sync-unpair": {
        done: "That device has stopped syncing this sandbox. Its local folder is left exactly as it is.",
        line: ({ sandboxId }) => forSandbox("intentic-machine sync uninstall", sandboxId),
        path: pairedFolder,
        scoped: true,
    },
    // Enrolls the device we are already talking to, instead of printing its one-liner for someone to paste there. The
    // token is minted for this call alone and never leaves the daemon.
    "sync-install": {
        done: "That device is enrolled. Its folder and this sandbox's ports appear on its row within a few seconds.",
        line: installLine,
        needs: "this sandbox has no public address for a device to dial yet",
        timeoutMs: LONG_COMMAND_TIMEOUT_MS,
        mints: true,
        // WHICH SIDE SYNCS IS THE FOLDER'S ANSWER, not a second thing to choose: mutagen has to watch the filesystem
        // that holds it, so a `C:\…` folder enrolls the Windows side and a `/home/…` folder the distro, whichever
        // door the browser happened to name. A ports-only enrollment has no folder and stays where it was sent.
        path: (facts) => (facts.mode === "mirror" ? undefined : facts.localDir),
    },
    /* Dev rebuilds run detached and record an exit mark for later polling. */
    "dev-rebuild": {
        done: "The rebuild is running on that device. Your sandbox restarts on the new image when it is built, and this page reconnects on its own.",
        // ENDS WITH A SECOND OF FOREGROUND, WHICH IS LOAD-BEARING. A crossed call (`in: "wsl:<distro>"`) is
        // `wsl.exe --exec sh -lc <script>`, and WSL kills the session's processes the moment that exits — with
        // nothing else in the foreground, the exit races the background job and wins, leaving no build and not even
        // a log file. A started child survives; this is what gets it started.
        // `$detach` is the other half of the same lesson, measured the same way: `nohup` saves a lone `sh` but not a
        // pnpm/node tree, which was killed as the build phase ended — 77 KB of build output and no exit mark, so the
        // card span for as long as anyone watched it. A session of its own is what survives.
        line: (facts) =>
            facts.devRoot === undefined || facts.ownSlug === undefined
                ? undefined
                : `${WITH_PNPM} ${OWN_SESSION} mkdir -p "$HOME/.intentic/logs" && cd ${shellDir(facts.devRoot)} && $detach nohup sh -c 'pnpm rebuild:sandbox ${facts.ownSlug}; printf "\\n${DEV_REBUILD_EXIT_MARK} %s\\n" "$?"' > ${shellDir(devRebuildLogPath(facts.ownSlug))} 2>&1 & sleep 1`,
        needs: "only a dev sandbox launched by dev-sandbox.sh knows which checkout to rebuild from",
        path: (facts) => facts.devRoot,
    },
    /* The read side of the command above, polled by whoever is watching. Bounded twice (bytes, then lines) because it
     * is polled every few seconds and a docker build's log is not small; the header is the log's own mtime, which is
     * what separates a build sitting inside a slow layer from one whose machine went to sleep. Needs only the slug —
     * reading a log takes the log's name, not the checkout it came from — so a sandbox can still be told how its last
     * rebuild ended after the checkout it was built from has moved. */
    "dev-rebuild-log": {
        done: "That device has no rebuild log for this sandbox.",
        line: (facts) =>
            facts.ownSlug === undefined
                ? undefined
                : `log=${shellDir(devRebuildLogPath(facts.ownSlug))}; if [ -f "$log" ]; then at=$(stat -c %Y "$log" 2>/dev/null || stat -f %m "$log" 2>/dev/null || echo); if [ -n "$at" ]; then echo "${DEV_REBUILD_QUIET_MARK} $(( $(date +%s) - at ))"; else echo "${DEV_REBUILD_QUIET_MARK} ?"; fi; tail -c 12000 "$log" | tail -n 80; else echo "${DEV_REBUILD_QUIET_MARK} -"; fi`,
        needs: "this sandbox does not know its own name, so it cannot name the log to read",
        timeoutMs: UNDER_LOAD_TIMEOUT_MS,
        // The log, not the checkout: this is the one dev command that needs no checkout, and the log lives in the home
        // of whichever environment ran the build.
        path: (facts) => (facts.ownSlug === undefined ? undefined : devRebuildLogPath(facts.ownSlug)),
    },
    // The dev inner loop, run where the checkout is: compile the daemon and restart this very container. The slug is
    // this sandbox's own, never the caller's, and the answer usually never arrives — the daemon carrying it is the one
    // being restarted, which the card treats as the expected ending.
    "dev-reload": {
        done: "Reloaded: the daemon is running the code in that checkout.",
        line: (facts) =>
            facts.devRoot === undefined || facts.ownSlug === undefined
                ? undefined
                : `${WITH_PNPM} sh ${shellDir(facts.devRoot)}/_sandbox/sandbox/scripts/dev-reload.sh ${facts.ownSlug}`,
        needs: "only a dev sandbox launched by dev-sandbox.sh knows which checkout to reload from",
        timeoutMs: LONG_COMMAND_TIMEOUT_MS,
        path: (facts) => facts.devRoot,
    },
};

// The environment's own platform leads: a distro on a Windows PC runs sh and holds Linux paths, so reading its card's
// platform here would write PowerShell for it and send every path through a crossing it doesn't need. The card answers
// for a door this daemon has no reading of.
const doorPlatform = (door: Device | undefined, card: Capability | undefined): string | undefined =>
    door?.platform ?? (card?.kind === "host" ? card.config.platform : undefined);

// Everything a line is built from, gathered once per call. A pairing is minted only for the command that asks for one,
// so no other action mints a credential as a side effect of being run.
const commandFacts = async (services: Services, input: DeviceCommandInput): Promise<DeviceCommandFacts> => {
    const spec = DEVICE_COMMANDS[input.command];
    // By card, since an environment of a machine is a connection of that card rather than a card of its own.
    const card = (await services.capabilities.list()).find((capability) => capability.id === hostCardOf(input.id));
    // Held readings only, never a fresh pull: the facts arrive at connect and a command must not wait on a laptop to
    // describe itself again before it can be sent.
    const door = (await heldHostDevices(services)).find((device) => device.hostId === input.id);
    return {
        sandboxId: input.sandboxId,
        ownSlug: ownSlug(services),
        devRoot: services.config.sandbox.devRoot,
        publicUrl: services.config.sandbox.publicUrl,
        platform: doorPlatform(door, card),
        hostFacts: door?.facts,
        mode: input.mode,
        localDir: input.localDir,
        pairedDir: door?.report?.pairings.find((pairing) => pairing.sandboxId === input.sandboxId)?.localDir,
        connections: services.hostHub.connected().filter((key) => hostCardOf(key) === hostCardOf(input.id)).map(hostEnvironmentOf),
        pairToken: spec.mints === true ? services.syncPairings.mint(input.mode ?? "sync").token : undefined,
    };
};

// How this door runs this command: itself, or by crossing into the environment of the same computer that holds the
// path. `in` is a `run_command` argument the machine turns into argv (`wsl.exe --exec sh -lc <script>`), so a PC
// connected only on its Windows side still rebuilds the checkout in its distro — one connected machine is enough,
// whichever side of it the owner connected. The refusal is for what is genuinely out of reach, and it names the
// candidates when a PC has two distros and nothing says which one has the folder.
export const doorRoute = (spec: DeviceCommandSpec, facts: DeviceCommandFacts, input: DeviceCommandInput): DeviceCommandRoute => {
    const path = spec.path?.(facts);
    if (path === undefined) {
        return {};
    }
    const reach = pathReach(facts.platform, facts.hostFacts, path);
    if (reach.kind === "direct") {
        return { environment: hostEnvironmentOf(input.id) };
    }
    if (reach.kind === "wsl") {
        const environment = `wsl:${reach.distro}`;
        // Its own agent if it has one — a distro connected in its own right needs no interop hop, and its login shell
        // is the one the owner's tools are installed in. Crossing is the fallback for an environment with no agent.
        return facts.connections.includes(environment)
            ? { environment, connection: hostConnectionKey(hostCardOf(input.id), environment) }
            : { environment, in: environment };
    }
    const several =
        reach.distros.length > 1
            ? ` That PC runs ${reach.distros.join(" and ")}, and nothing here says which holds it — connect the one that does, and it answers directly.`
            : ``;
    return {
        refusal:
            `"${input.command}" runs ${path}, which "${input.id}" cannot reach: its own shell does not speak that path, ` +
            `and no environment of that computer is reachable from it.${several}`,
    };
};

// Which connection of that machine carries the call: the target environment's own agent when it has one, else the
// door the caller named, which then crosses.
const sentTo = (route: DeviceCommandRoute, id: string): string => route.connection ?? id;

// run_command answers with an exit line plus fenced stdout/stderr; success reads the exit line only, never what was
// printed.
const STDOUT_FENCE = "--- stdout ---";
const STDERR_FENCE = "--- stderr ---";

export const succeeded = (text: string): boolean => /^Exit code 0 \(success\)/m.test(text);

// One stream out of the fenced answer; absent is an empty string, which every caller treats as "say something else
// instead".
export const streamOf = (text: string, fence: string): string => {
    const start = text.indexOf(fence);
    if (start === -1) {
        return "";
    }
    const rest = text.slice(start + fence.length);
    const end = [STDOUT_FENCE, STDERR_FENCE].map((other) => rest.indexOf(other)).filter((at) => at !== -1);
    return (end.length === 0 ? rest : rest.slice(0, Math.min(...end))).trim();
};

// The CLI's own sentence wins when there is one, the same words the terminal would show. On failure, stderr comes
// first, falling back to the whole answer if nothing readable came back.
export const outcomeOf = (command: DeviceCommand, answer: { text: string; refused: boolean }): DeviceCommandResult => {
    const spec = DEVICE_COMMANDS[command];
    if (answer.refused) {
        // The host agent's refusal is a value naming the switch, not an error to dress up.
        return {
            ok: false,
            refused: true,
            message: answer.text.trim() === "" ? "That device refused to run commands." : answer.text.trim(),
            output: answer.text,
        };
    }
    const out = streamOf(answer.text, STDOUT_FENCE);
    if (succeeded(answer.text)) {
        return { ok: true, refused: false, message: out === "" ? spec.done : out, output: answer.text };
    }
    const err = streamOf(answer.text, STDERR_FENCE);
    // The device took the command and it ended badly — a non-zero exit, or its own deadline. Both are this attempt's
    // outcome rather than the device's answer to being asked at all.
    return { ok: false, refused: false, message: [err, out].find((part) => part !== "") ?? answer.text.trim(), output: answer.text };
};

// Only an unreachable machine throws. Everything the machine actually answered, a refusal or a nonzero exit, comes back
// as ok: false carrying its words.
export const runDeviceCommand = async (services: Services, input: DeviceCommandInput): Promise<DeviceCommandResult> => {
    const spec = DEVICE_COMMANDS[input.command];
    // Refused here, not in the schema, since the field is optional for the other switches and only this one needs it.
    if (spec.scoped === true && input.sandboxId === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `"${input.command}" has to name the sandbox it acts on.` });
    }
    const facts = await commandFacts(services, input);
    const route = doorRoute(spec, facts, input);
    if (route.refusal !== undefined) {
        throw new ORPCError("CONFLICT", { message: route.refusal });
    }
    const line = spec.line(facts, route);
    // A line this sandbox cannot form is a fact about where it runs, not something the device could answer.
    if (line === undefined) {
        throw new ORPCError("CONFLICT", { message: `"${input.command}" isn't available here: ${spec.needs ?? "this sandbox cannot form it"}.` });
    }
    const timeoutMs = spec.timeoutMs ?? COMMAND_TIMEOUT_MS;
    try {
        const answer = await callTool(
            services,
            sentTo(route, input.id),
            "run_command",
            // `in` only when the line has to cross: an agent old enough to reject the argument is never sent one,
            // because the same release that took `in` is the one that reports the distros the route is read from.
            { command: line, timeoutMs, ...(route.in === undefined ? {} : { in: route.in }) },
            AbortSignal.timeout(timeoutMs + CALL_SLACK_MS),
        );
        return outcomeOf(input.command, answer);
    } catch (error) {
        throw new ORPCError("CONFLICT", {
            message:
                error instanceof Error
                    ? error.message
                    : `"${input.id}" could not be reached: the device is asleep, offline, or its agent isn't running.`,
        });
    } finally {
        // Forget timed-out pulls so the next read cannot use stale state.
        forgetPull(input.id);
    }
};
