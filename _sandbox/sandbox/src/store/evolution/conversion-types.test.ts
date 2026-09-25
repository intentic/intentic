import { z } from "zod";
import { drop, rename } from "./conversions.js";
import type { VanishedKeys } from "./conversion-types.js";
import { defineDocument } from "./documents.js";

// The vanished-key check the generated shape checks (untracked) apply to every frozen shape, pinned on shapes small enough to
// read: what it names, and what it must not.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const holds = <T extends true>(): T | undefined => undefined;

const settingsSchema = z.object({
    routing: z.string().default("auto"),
    agent: z.object({ model: z.string(), effort: z.string().optional() }).optional(),
    pins: z.array(z.object({ id: z.string() })).optional(),
    labels: z.record(z.string(), z.object({ colour: z.string() })).optional(),
});
const plain = defineDocument({ path: "evolution/settings.json", schema: settingsSchema });
const converted = defineDocument({ path: "evolution/converted.json", schema: settingsSchema, history: [rename("personaRouting", "routing"), drop("legacy")] });
const stepped = defineDocument({ path: "evolution/stepped.json", schema: settingsSchema, movedByStep: ["agent.token"] });

type Old = {
    personaRouting?: string;
    legacy?: boolean;
    agent?: { model: string; token?: string; temperature?: number };
    pins?: { id: string; pinnedAt?: number }[];
    labels?: Record<string, { colour: string; hue?: number }>;
};

test("a key renamed or removed without its conversion is named, at any depth, by its dotted path", () => {
    expect(holds<Same<VanishedKeys<Old, typeof plain>, "personaRouting" | "legacy" | "agent.token" | "agent.temperature" | "pins.[].pinnedAt" | "labels.{}.hue">>()).toBeUndefined();
});

test("a rename or a drop in the history, or a step that moves the key, answers for it", () => {
    expect(holds<Same<VanishedKeys<Old, typeof converted>, "agent.token" | "agent.temperature" | "pins.[].pinnedAt" | "labels.{}.hue">>()).toBeUndefined();
    expect(holds<Same<VanishedKeys<Old, typeof stepped>, "personaRouting" | "legacy" | "agent.temperature" | "pins.[].pinnedAt" | "labels.{}.hue">>()).toBeUndefined();
});

test("today's own shape, a shape with nothing in it, and an old field of any shape vanish nothing", () => {
    expect(holds<Same<VanishedKeys<z.input<typeof settingsSchema>, typeof plain>, never>>()).toBeUndefined();
    expect(holds<Same<VanishedKeys<Record<never, never>, typeof plain>, never>>()).toBeUndefined();
    // The frozen spelling of a field whose schema could not be written down.
    expect(holds<Same<VanishedKeys<{ agent?: any }, typeof plain>, never>>()).toBeUndefined();
});
