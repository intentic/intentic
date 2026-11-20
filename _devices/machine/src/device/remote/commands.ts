import { isProcessAlive, type Item, type Tone } from "@intentic/local-agent";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { buildCommand, machineUi } from "../../cli-ui.js";
import { audit } from "../audit.js";
import { readRemotedConfig, readRemotedStatus, type RemotedStatus, remotedConfigPath, updateRemotedConfig } from "./remoted-files.js";

/* `intentic-machine remote end` and `remote status` (2026-11-20): the way the person at this computer ends people's
   remote access from here, and sees who has it. remoted is the resident agent's child, so neither talks to it: `end`
   rewrites its config (`notBefore`, which remoted re-reads within half a second, dropping everyone connected and every
   way in handed out before it), and `status` reads the last status the agent kept beside that config. */

const hostOf = (sandboxUrl: string): string => URL.parse(sandboxUrl)?.host ?? sandboxUrl;
const when = (ms: number): string => new Date(ms).toISOString();

// An uplink's state as a row's tone; a state a newer remoted adds reads as something to look at.
const UPLINK_TONES: ReadonlyMap<string, Tone> = new Map<string, Tone>([
    ["up", "ok"],
    ["connecting", "warn"],
    ["down", "warn"],
    ["withdrawn", "skip"],
    ["refused", "fail"],
]);

// The status as rows: each uplink with its state, each person with what they do. Pure.
export const uplinkItems = (status: RemotedStatus): Item[] =>
    status.uplinks.map((uplink) => ({
        tone: UPLINK_TONES.get(uplink.state) ?? "warn",
        name: hostOf(uplink.id),
        meta: `${uplink.state} since ${when(uplink.since)}${uplink.error === undefined ? "" : `: ${uplink.error}`}`,
    }));

export const peopleItems = (status: RemotedStatus): Item[] =>
    status.people.map((person) => ({
        tone: "ok",
        name: `${person.kind} ${person.session}`,
        meta: `from ${hostOf(person.uplink)} since ${when(person.since)}${person.readOnly === true ? ", read-only" : ""}`,
    }));

const end = buildCommand({
    docs: { brief: "Drop everyone connected to this computer remotely, and refuse every way in they were given" },
    parameters: {},
    async func(this: CommandContext) {
        const ui = machineUi(this.process);
        ui.act("Ending people's remote access to this computer");
        if ((await readRemotedConfig()) === undefined) {
            ui.done("Nobody has been let in remotely here, so there was nothing to end.");
            return;
        }
        const at = Date.now();
        await updateRemotedConfig((config) => ({ ...config, notBefore: at }));
        await audit({
            tool: "remote-end",
            ok: true,
            detail: `everyone dropped by the person at this computer (intentic-machine remote end), notBefore ${when(at)}`,
        });
        ui.done("Ended it: everyone connected is dropped within a second, and a way in handed out before now no longer opens.");
        ui.later([["see who is connected", "intentic-machine remote status"]]);
    },
});

interface StatusFlags {
    readonly json: boolean;
}

const status = buildCommand<StatusFlags>({
    docs: { brief: "Show who is connected to this computer remotely, and remoted's uplinks to your sandboxes" },
    parameters: { flags: { json: { kind: "boolean", brief: "Print remoted's last status as JSON", default: false } } },
    async func(this: CommandContext, flags: StatusFlags) {
        const said = await readRemotedStatus();
        const running = said !== undefined && isProcessAlive(said.pid);
        if (flags.json) {
            // allow(terminal-output): the --json document, one line
            this.process.stdout.write(`${JSON.stringify(running ? { running, ...said } : { running: false })}\n`);
            return;
        }
        const ui = machineUi(this.process);
        ui.report("intentic · remote access", remotedConfigPath);
        if (!running) {
            ui.quiet("intentic-remoted is not running, so nobody is connected to this computer remotely.");
            return;
        }
        ui.fields([
            ["remoted", `${said.version} (pid ${said.pid})`],
            ["terminals open", String(said.terminals)],
            ["environments", said.environments.join(", ") || "none"],
        ]);
        ui.section(`uplinks (${said.uplinks.length})`);
        ui.items(uplinkItems(said));
        if (said.people.length > 0) {
            ui.section(`people connected (${said.people.length})`);
            ui.items(peopleItems(said));
        }
        ui.later([["drop everyone", "intentic-machine remote end"]]);
    },
});

export const remoteRoutes = buildRouteMap({
    routes: { end, status },
    docs: { brief: "People's remote desktop and terminals on this computer: who is connected, and ending it" },
});
