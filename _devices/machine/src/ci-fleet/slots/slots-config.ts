import { z } from "zod";

// The test-memory pool's settings in /etc/intentic-ci/fleet.json (`slots`): the pool the workflows name
// (`TEST_SLOTS_DIR`, `TEST_SLOTS`, `TEST_SLOTS_RESERVED` in ci.yml), and how many of its slots CI may use on this host
// at most (`usable`, what `setup-linux-runner.sh --test-slots` used to keep).
export const SlotsConfigSchema = z.object({
    enabled: z.boolean().default(true),
    dir: z.string().default("/ci-cache/test-slots"),
    total: z.number().int().positive().default(16),
    reserved: z.number().int().nonnegative().default(6),
    usable: z.number().int().positive().optional(),
});
export type SlotsConfig = z.infer<typeof SlotsConfigSchema>;
