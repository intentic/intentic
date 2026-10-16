import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    IC_OS_NOT_INTENTIC_OS_EXIT,
    icOsChannelArgs,
    icOsRebootArgs,
    icOsRollbackArgs,
    icOsStatusArgs,
    icOsUpdateArgs,
    INTENTIC_OS_RELEASE_PATH,
    type IntenticOsChannel,
    IntenticOsChannelSchema,
    type IntenticOsFacts,
    intenticOsFactsFrom,
    IntenticOsReleaseSchema,
    IntenticOsStatusSchema,
    IntenticOsUpdateCheckSchema,
    type IntenticOsUpdateOp,
    IntenticOsUpdateOpSchema,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { prettifyError, z } from "zod";
import { assertScope } from "../../policy.js";
import { type IcRun, runIc } from "../sandboxes.js";

// THE MACHINE'S OWN OS, on Intentic OS (2026-10-13, _os/README.md): the immutable Linux that boots straight into
// Intentic, where the first sandbox is the box's steward and manages it through these tools. They are thin callers of
// `ic os …`, exactly as sandboxes.ts is of `ic sandbox …`: the same ic, found and kept current the same way (runIc), argv
// spelled by the contract, JSON read as the contract's. ic owns the OS: it stages with bootc, leaves every sandbox its
// resume ask before a reboot, and records what runs so the next boot's health check expects it back. Nothing here
// reimplements any of that. Registered only on a machine that is Intentic OS (osTools), since `ic os` refuses
// everywhere else.

// `bootc status` through `sudo -n` and a read of the health file: past this a machine is in trouble, and a model waits.
const STATUS_DEADLINE_MS = 60_000;
// A registry round trip for the newest image's digest.
const CHECK_DEADLINE_MS = 3 * 60_000;

/** One `ic os` run: a bounded read when `deadlineMs` is set, else a flow left to finish (a download, a reboot).
 *  `input` goes to ic's stdin, for a secret that must not be in its argv (settings.ts, a Wi-Fi password). */
export type OsIc = (args: readonly string[], options: { readonly deadlineMs?: number | undefined; readonly input?: string | undefined }) => Promise<IcRun>;

const runOsIc: OsIc = async (args, { deadlineMs, input }) => await runIc(args, () => {}, {}, { deadlineMs, input });

// What `ic os` says on a machine that is not Intentic OS. The tools are not offered there, so this is a release.json
// that went missing under a running agent.
export const notIntenticOs = (run: IcRun): void => {
    if (run.code === IC_OS_NOT_INTENTIC_OS_EXIT) {
        throw new Error(`This device is not running Intentic OS (it has no ${INTENTIC_OS_RELEASE_PATH}), so it has no OS for ic to manage.\n\n${run.output}`);
    }
};

// ic prints its one line of JSON last (a note, if any, goes before it on stderr): read and checked, never trusted.
export const answerOf = <T>(output: string, schema: z.ZodType<T>, verb: string): T => {
    const line = output
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("{"));
    let json: unknown;
    try {
        json = line === undefined ? undefined : JSON.parse(line);
    } catch {
        // allow(silent-catch): a line that is not JSON is the same answer as none, said below with ic's own output
        json = undefined;
    }
    const read = schema.safeParse(json);
    if (!read.success) {
        throw new Error(
            `The ic on this device did not answer \`ic ${verb}\` in the shape this agent reads${json === undefined ? "" : ` (${prettifyError(read.error)})`}. Re-run the sandbox's install command on it to update ic.\n\n${output}`,
        );
    }
    return read.data;
};

// The line ic ended on, which says what it did ("staged 2026.10.14.0", "already up to date").
const lastLine = (output: string): string | undefined => output.split(/\r?\n/).findLast((line) => line.trim() !== "")?.trim();

// What every reboot answers with, when the call returns at all: the machine is going down under it.
const REBOOT_NOTE =
    "A reboot restarts every sandbox on this device, the one this call came from included, and each picks up again once it is back. " +
    "If a boot fails its health checks, greenboot reboots it, and after three failed boots rolls back to the previous deployment by itself. " +
    "Once it is back, check os_status (`health`) and list_sandboxes.";

export const said = (run: IcRun, fallback: string): string => lastLine(run.output) ?? fallback;

export interface OsDeps {
    readonly ic: OsIc;
}
export const OS_DEPS: OsDeps = { ic: runOsIc };

// A way of seeing, like the sandbox listing: either grant. The settings tools' reads are gated the same (settings.ts).
export const assertSeeing = (scopes: DeviceScopes): void => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
};

/** `ic os status --json`, read as the contract's and answered as JSON: a model reads keys as well as prose. */
export const osStatus = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertSeeing(scopes);
    const run = await deps.ic(icOsStatusArgs(), { deadlineMs: STATUS_DEADLINE_MS });
    notIntenticOs(run);
    if (run.code !== 0) {
        throw new Error(`ic could not say this device's OS status.\n\n${run.output}`);
    }
    return JSON.stringify(answerOf(run.output, IntenticOsStatusSchema, "os status --json"), undefined, 2);
};

// `check` asks the registry and changes nothing, so it is gated as a read; staging and applying take `sandboxes`.
export const osUpdate = async (op: IntenticOsUpdateOp, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    if (op === "check") {
        assertSeeing(scopes);
        const run = await deps.ic(icOsUpdateArgs("check"), { deadlineMs: CHECK_DEADLINE_MS });
        notIntenticOs(run);
        if (run.code !== 0) {
            throw new Error(`ic could not ask whether a newer OS image is out.\n\n${run.output}`);
        }
        return JSON.stringify(answerOf(run.output, IntenticOsUpdateCheckSchema, "os update --check --json"), undefined, 2);
    }
    assertScope(scopes, "sandboxes");
    const run = await deps.ic(icOsUpdateArgs(op), {});
    notIntenticOs(run);
    if (run.code !== 0) {
        throw new Error(`That OS update ${op === "stage" ? "could not be staged" : "failed"} on this device. Nothing was rebooted.\n\n${run.output}`);
    }
    return op === "stage"
        ? `${said(run, "Staged.")}\n\nNothing restarted: a staged update applies at the next boot (os_status shows it under \`staged\`), and os_reboot or os_update "apply" boots into it.`
        : `${said(run, "Rebooting into the new OS image.")}\n\n${REBOOT_NOTE}`;
};

export const osRollback = async (apply: boolean, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await deps.ic(icOsRollbackArgs(apply), {});
    notIntenticOs(run);
    if (run.code !== 0) {
        throw new Error(`That OS rollback failed on this device. Nothing was rebooted.\n\n${run.output}`);
    }
    return apply
        ? `${said(run, "Rebooting into the previous deployment.")}\n\n${REBOOT_NOTE}`
        : `${said(run, "Rollback queued.")}\n\nNothing restarted: the next boot goes back to the previous deployment (os_status: \`rollbackQueued\`).`;
};

export const osReboot = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await deps.ic(icOsRebootArgs(), {});
    notIntenticOs(run);
    if (run.code !== 0) {
        throw new Error(`This device could not be rebooted.\n\n${run.output}`);
    }
    return `${said(run, "Rebooting.")}\n\n${REBOOT_NOTE}`;
};

export const osChannel = async (channel: IntenticOsChannel, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await deps.ic(icOsChannelArgs(channel), {});
    notIntenticOs(run);
    if (run.code !== 0) {
        throw new Error(`This device could not be switched to the ${channel} channel.\n\n${run.output}`);
    }
    return `${said(run, `Staged the ${channel} channel's image.`)}\n\nNothing restarted: it applies at the next boot, like any staged update.`;
};

// What a device on Intentic OS reports in its facts, from release.json's text; undefined for none or for one that does
// not say its edition, version and channel. Pure, so the reading is asserted without the file.
export const intenticOsFactsOf = (text: string | undefined): IntenticOsFacts | undefined => {
    if (text === undefined) {
        return undefined;
    }
    const release = parseJsonWith(text, IntenticOsReleaseSchema);
    return release === undefined ? undefined : intenticOsFactsFrom(release);
};

export const readIntenticOs = async (release: string = INTENTIC_OS_RELEASE_PATH): Promise<IntenticOsFacts | undefined> =>
    intenticOsFactsOf(await readFile(release, "utf8").catch(undefinedIfMissing));

// The tools, each in the voice of the sandbox tools beside them. Every one that reboots says, in so many words, that it
// takes the caller's own sandbox down with the rest: the call ends the caller's turn.
const OS_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    tool({
        name: "os_status",
        description:
            "This device's Intentic OS, as JSON from the device's `ic os status`: its edition, version and the channel it follows, the deployment it booted (`booted`), the update staged for its next boot (`staged`, null when none), the deployment it can go back to (`rollback`), whether a rollback is queued, whether the next boot changes what runs (`rebootRequired`), this boot's health verdict (`health`: green, red or unknown, and which checks failed) and how sandboxes are isolated (`isolation`, `vmRuntime`). Changes nothing: call it first, and again after a reboot. Requires 'Run commands' or 'Manage sandboxes on this device'.",
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await osStatus(scopes, deps)),
    }),
    tool({
        name: "os_update",
        description:
            "Update this device's Intentic OS through its `ic os update`. 'check' asks the registry whether a newer image is out and changes nothing. 'stage' downloads it and stages it for the next boot: nothing restarts, and the machine runs as it is until it reboots. 'apply' stages it and then REBOOTS THE WHOLE MACHINE into it, which restarts every sandbox on it, the one you are calling from included: your turn ends with the call, so say what will happen and get the owner's yes in chat before calling it. Each sandbox is left a note to pick up again, and a boot that keeps failing its health checks is rolled back by greenboot to the previous deployment. 'check' requires 'Run commands' or 'Manage sandboxes on this device'; 'stage' and 'apply' require 'Manage sandboxes on this device'.",
        effect: "write",
        input: z.object({ op: IntenticOsUpdateOpSchema.describe("'check' asks, 'stage' downloads for the next boot, 'apply' stages and reboots.") }),
        run: async ({ op }, scopes) => textResult(await osUpdate(op, scopes, deps)),
    }),
    tool({
        name: "os_rollback",
        description:
            "Go back to this device's previous Intentic OS deployment (`rollback` in os_status) through its `ic os rollback`. Without `apply` it queues the rollback for the next boot and restarts nothing. `apply: true` then REBOOTS THE WHOLE MACHINE into it, restarting every sandbox on it, the one you are calling from included, which ends your turn: get the owner's yes in chat first. Requires the 'Manage sandboxes on this device' permission.",
        effect: "write",
        input: z.object({ apply: z.boolean().optional().describe("Reboot into the previous deployment now, rather than at the next boot.") }),
        run: async ({ apply }, scopes) => textResult(await osRollback(apply === true, scopes, deps)),
    }),
    tool({
        name: "os_reboot",
        description:
            "Reboot this device the orderly way, through its `ic os reboot`: every running sandbox is left a note to pick up again and recorded, so the next boot's health check expects it back, then the machine restarts, into the staged update or queued rollback when there is one (os_status `rebootRequired`). It restarts every sandbox on this device, the one you are calling from included, so your turn ends with the call: get the owner's yes in chat first. Requires the 'Manage sandboxes on this device' permission.",
        effect: "write",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await osReboot(scopes, deps)),
    }),
    tool({
        name: "os_channel",
        description:
            "Switch which channel this device's Intentic OS follows, 'stable' or 'beta', keeping its edition, through its `ic os channel`: the same edition's image from that channel is downloaded and staged for the next boot, and nothing restarts. Requires the 'Manage sandboxes on this device' permission.",
        effect: "write",
        input: z.object({ channel: IntenticOsChannelSchema }),
        run: async ({ channel }, scopes) => textResult(await osChannel(channel, scopes, deps)),
    }),
];

/** The os_* tools, on a machine that is Intentic OS (its release.json exists) and nowhere else. */
export const osTools = (release: string = INTENTIC_OS_RELEASE_PATH, deps: OsDeps = OS_DEPS): McpTool<DeviceScopes>[] => (existsSync(release) ? OS_TOOLS(deps) : []);
