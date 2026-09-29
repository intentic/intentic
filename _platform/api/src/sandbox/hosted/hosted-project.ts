import { projectDirNameOf } from "@intentic/sandbox-contract";
import type { Config } from "../../config.js";
import { getMachineLaunch } from "./fly/fly.js";

/* A HOSTED PROJECT: a machine made for one folder of the owner's computer, which the desktop app copies into
 * `/work/<name>` once the machine runs. The daemon reads the folder from SANDBOX_PROJECT_DIR, as `ic` hands it to a
 * project container on the owner's own computer (connect.rs): no starter site beside it, and its agents told where to
 * work.
 *
 * The machine's own environment is the only record of it; no row holds it. Every config that replaces a machine's
 * (a restart, a rollback, a rebuild's apply, a resize or a move, a restore from the trash, a wake's heal) is composed
 * from scratch, so each carries the folder over from the config it replaces, as `ic` replays it on a recreate
 * (sandbox-run's REPLAY_ENV). A probe keeps it too (gate/state-gate.ts), so the config a dead gate left behind still
 * names it. A machine the provider lost takes its folder with it: its replacement is an ordinary sandbox. */

export const ENV_PROJECT_DIR = `SANDBOX_PROJECT_DIR`;

// The folder a machine's environment names, or undefined for an ordinary sandbox's.
export const projectOfEnv = (env: Readonly<Record<string, string>>): string | undefined => projectDirNameOf(env[ENV_PROJECT_DIR] ?? ``);

// The folder the machine was made for, read off the config it holds now.
export const hostedProjectOf = async (config: Config, machine: { readonly appName: string; readonly machineId: string }): Promise<string | undefined> =>
    projectOfEnv((await getMachineLaunch(config.hosted.flyApiToken, machine.appName, machine.machineId)).env ?? {});
