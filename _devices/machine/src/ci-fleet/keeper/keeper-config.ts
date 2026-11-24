import { z } from "zod";

// The keeper's settings in /etc/intentic-ci/fleet.json (`keeper`): whether it starts runner units that are down.
export const KeeperConfigSchema = z.object({
    enabled: z.boolean().default(true),
});
