import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { writeFileAtomic } from "@intentic/base/fs";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import { agentAssetName, agentAssetUrl, downloadAsset } from "../release.js";
import { verifyReleaseFiles } from "../release/release-verify.js";
import { MACHINE_VERSION } from "../version.js";
import { type FleetConfig, FleetConfigSchema } from "./config.js";
import { FLEET_BINARY, FLEET_CONFIG_DIR, FLEET_CONFIG_PATH, FLEET_LIB_DIR, FLEET_RUN_DIR, FLEET_UNIT, FLEET_UNIT_PATH, RETIRED_UNITS } from "./paths.js";
import { answered, type FleetSys, machineSys } from "./sys.js";

/* SETTING THE FLEET SERVICE UP, once per computer, as root (`sudo intentic-machine ci-fleet install --user <you>`, or
   the runner setup scripts, which already run as root). The binary root runs is a release's own, downloaded here and
   checked against its signed SHA256SUMS, never the copy in the person's home that they (and whatever runs as them)
   can write. A build from source has no release to check against and must name a binary (`--binary`), which is then
   what the person vouches for. The units the service replaces (the janitor's and the host prune's timers, the static
   slot holder) are disabled, not deleted, so turning the service off and those back on is one systemctl each. */

export interface InstallOptions {
    readonly user: string;
    // The host prune: for a computer whose Docker is its own, not Windows' Docker Desktop.
    readonly prune?: boolean | undefined;
    // How many test-memory slots CI may use on this host at most.
    readonly slotsUsable?: number | undefined;
    // A binary to install instead of the release's, for an agent built from source.
    readonly binary?: string | undefined;
}

export const fleetUnitText = (): string =>
    [
        "[Unit]",
        "Description=Intentic CI fleet: keeps this computer's GitHub Actions runners, their caches and the test-memory pool",
        "Documentation=https://github.com/intentic/intentic/blob/main/docs/ops/ci-runner.md",
        "After=network-online.target docker.service",
        "Wants=network-online.target",
        "",
        "[Service]",
        `ExecStart=${FLEET_BINARY} ci-fleet serve`,
        // An update replaces the binary and exits: systemd starts the new one.
        "Restart=always",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ].join("\n");

// The settings as they were, with what this install says on top.
export const mergedConfig = (before: FleetConfig | undefined, options: InstallOptions): FleetConfig => {
    const base = before ?? FleetConfigSchema.parse({ user: options.user });
    return FleetConfigSchema.parse({
        ...base,
        user: options.user,
        prune: { ...base.prune, ...(options.prune === undefined ? undefined : { enabled: options.prune }) },
        slots: { ...base.slots, ...(options.slotsUsable === undefined ? undefined : { usable: options.slotsUsable }) },
    });
};

const placeBinary = async (options: InstallOptions, say: (line: string) => void): Promise<void> => {
    await mkdir(FLEET_LIB_DIR, { recursive: true, mode: 0o755 });
    const next = `${FLEET_BINARY}.next`;
    if (options.binary !== undefined) {
        await copyFile(options.binary, next);
        say(`binary: ${options.binary}, as named (not checked against a release)`);
    } else if (MACHINE_VERSION === DEV_VERSION || MACHINE_VERSION === "0.0.0") {
        throw new Error("This agent was built from source and has no release to download the service's binary from: name one with --binary.");
    } else {
        await downloadAsset(agentAssetUrl(MACHINE_VERSION), next);
        const signed = await verifyReleaseFiles(MACHINE_VERSION, [{ name: agentAssetName(), path: next }]);
        say(`binary: v${MACHINE_VERSION} from its release, ${signed}`);
    }
    await chmod(next, 0o755);
    await rename(next, FLEET_BINARY);
};

const systemctl = async (sys: FleetSys, args: readonly string[]): Promise<void> => {
    answered(`systemctl ${args.join(" ")}`, await sys.run("systemctl", args, { timeoutMs: 120_000 }));
};

const requireRoot = (): void => {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
        throw new Error("The CI fleet service is set up as root on Linux: run this with sudo.");
    }
};

export const installFleet = async (options: InstallOptions, say: (line: string) => void, sys: FleetSys = machineSys): Promise<void> => {
    requireRoot();
    answered(`id ${options.user}`, await sys.run("id", ["-u", options.user], { timeoutMs: 10_000 }));
    await placeBinary(options, say);
    const kept = await sys.readText(FLEET_CONFIG_PATH);
    let before: FleetConfig | undefined;
    try {
        before = kept === undefined ? undefined : FleetConfigSchema.parse(JSON.parse(kept));
    } catch {
        // allow(silent-catch): settings that do not read are replaced whole by this install's, which it says
        say(`settings: ${FLEET_CONFIG_PATH} did not read, so it is written anew`);
    }
    const config = mergedConfig(before, options);
    await mkdir(FLEET_CONFIG_DIR, { recursive: true, mode: 0o755 });
    await writeFileAtomic(FLEET_CONFIG_PATH, `${JSON.stringify(config, undefined, 2)}\n`, 0o644);
    say(`settings: ${FLEET_CONFIG_PATH} (for ${config.user}; host prune ${config.prune.enabled ? "on" : "off"}; ${config.slots.usable ?? config.slots.total} of ${config.slots.total} test slots usable by CI)`);
    await writeFileAtomic(FLEET_UNIT_PATH, fleetUnitText(), 0o644);
    await systemctl(sys, ["daemon-reload"]);
    for (const unit of RETIRED_UNITS) {
        // one at a time. `systemctl cat` answers by its exit status alone whether this host has the unit; one it never had
        // is not an error, and one it has is disabled and stopped, or the install stops saying why.
        const present = await sys.run("systemctl", ["cat", unit], { timeoutMs: 30_000 });
        if (present.status === 0) {
            await systemctl(sys, ["disable", "--now", unit]);
            say(`retired: ${unit}`);
        }
    }
    await systemctl(sys, ["enable", FLEET_UNIT]);
    await systemctl(sys, ["restart", FLEET_UNIT]);
    say(`service: ${FLEET_UNIT} enabled and started`);
};

export const uninstallFleet = async (say: (line: string) => void, sys: FleetSys = machineSys): Promise<void> => {
    requireRoot();
    await sys.run("systemctl", ["disable", "--now", FLEET_UNIT], { timeoutMs: 120_000 });
    await rm(FLEET_UNIT_PATH, { force: true });
    await systemctl(sys, ["daemon-reload"]);
    await rm(FLEET_LIB_DIR, { recursive: true, force: true });
    await rm(FLEET_RUN_DIR, { recursive: true, force: true });
    say(`removed ${FLEET_UNIT} and ${FLEET_LIB_DIR}; ${FLEET_CONFIG_DIR} and the state folder are kept, and the runners run on untouched`);
};
