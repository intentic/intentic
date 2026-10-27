import { e2eTier } from "@intentic/testing/e2e";
import type { z } from "zod";

export type WorldKind = "fake" | "live";

export interface World {
    readonly kind: WorldKind;
    readonly close: () => Promise<void>;
}

export interface Scenario<W extends World> {
    readonly name: string;
    readonly writes?: true;
    readonly fakeOnly?: string;
    readonly todo?: string;
    readonly requiredSecrets?: readonly string[];
    readonly run: (world: W) => Promise<void>;
}

const registerScenario = <W extends World>(scenario: Scenario<W>, kind: WorldKind, secrets: readonly string[], world: () => W): void => {
    if (scenario.writes === true && (scenario.requiredSecrets?.length ?? 0) === 0) {
        throw new Error(`write scenario "${scenario.name}" must name its scratch-target secret`);
    }
    const tier = e2eTier(scenario.name, {
        enabledBy: "INTENTIC_E2E_CAPABILITIES",
        secrets: [...secrets, ...(scenario.requiredSecrets ?? [])],
    });
    const fakeOnly = kind === "live" && scenario.fakeOnly !== undefined;
    const title = fakeOnly ? `${scenario.name} (fake only: ${scenario.fakeOnly})` : kind === "live" ? tier.title : scenario.name;
    const skip = fakeOnly || (kind === "live" && !tier.runs);
    if (scenario.todo !== undefined && !skip) {
        test.todo(`${title} (todo: ${scenario.todo})`, async () => scenario.run(world()));
        return;
    }
    test.skipIf(skip)(title, async () => scenario.run(world()));
};

export const registerConformance = <W extends World>(options: {
    readonly name: string;
    readonly kind: WorldKind;
    readonly scenarios: readonly Scenario<W>[];
    readonly secrets: readonly string[];
    readonly create: () => Promise<W>;
}): void => {
    const tier = e2eTier(options.name, { enabledBy: "INTENTIC_E2E_CAPABILITIES", secrets: options.secrets });
    describe.skipIf(options.kind === "live" && !tier.runs)(options.kind === "live" ? tier.title : options.name, () => {
        let world: W;
        beforeAll(async () => {
            world = await options.create();
        });
        afterAll(async () => {
            await world?.close();
        });
        for (const scenario of options.scenarios) {
            registerScenario(scenario, options.kind, options.secrets, () => world);
        }
    });
};

// The same consumed-field schema checks raw fake and live answers alongside the documented jq output.
export const responseJson = <T>(schema: z.ZodType<T>, text: string): T => schema.parse(JSON.parse(text));
