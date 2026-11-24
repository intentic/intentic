import { readFile } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import { JanitorConfigSchema } from "./janitor/janitor-config.js";
import { KeeperConfigSchema } from "./keeper/keeper-config.js";
import { FLEET_CONFIG_PATH } from "./paths.js";
import { PruneConfigSchema } from "./prune/prune-config.js";
import { SlotsConfigSchema } from "./slots/slots-config.js";

/* THE FLEET SERVICE'S SETTINGS, /etc/intentic-ci/fleet.json, written by `ci-fleet install` and read as the service
   starts. Root's file: the person's agent reads the service's answers, never this. Every section defaults whole, so a
   file holding only `{ "user": "radarsu" }` is a working fleet with the old scripts' numbers. */

export const FleetConfigSchema = z.object({
    // The account the person's agent runs as: its group may ask on the socket.
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u),
    // The shared cache root every job mounts (ci-runner.md).
    cacheRoot: z.string().default("/ci-cache"),
    // The service's own state: holds, the last passes, the janitor's trash and its compact request.
    stateDir: z.string().default("/var/lib/intentic-ci"),
    keeper: KeeperConfigSchema.default(KeeperConfigSchema.parse({})),
    janitor: JanitorConfigSchema.default(JanitorConfigSchema.parse({})),
    prune: PruneConfigSchema.default(PruneConfigSchema.parse({})),
    slots: SlotsConfigSchema.default(SlotsConfigSchema.parse({})),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

export const readFleetConfig = async (path: string = FLEET_CONFIG_PATH): Promise<FleetConfig> => {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        throw new Error(`could not read ${path} (${errorMessage(error)}): \`sudo intentic-machine ci-fleet install --user <you>\` writes it`, { cause: error });
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`${path} is not JSON: ${errorMessage(error)}`, { cause: error });
    }
    const parsed = FleetConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${path} does not read as the fleet's settings: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
};
