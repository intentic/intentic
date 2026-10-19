import type { DeviceSandboxFlow } from "@intentic/sandbox-contract/schemas/devices";
import { type DeviceFeature, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";

// The ops an agent can't do, refused here before anything reaches the machine, each with the feature it needs and the
// sentence it is refused with. An agent that predates `later` drops it and reshapes at once, restarting the sandbox under
// everyone working in it: the opposite of what Save promised. One that predates `set-shape`, `prepare-background` or
// `sleep` refuses the op by name anyway, so these only say why, and what to do, in words.
const FEATURE_GATES: readonly {
    readonly asks: (input: DeviceSandboxFlow) => boolean;
    readonly feature: DeviceFeature;
    readonly refusal: (id: string) => string;
}[] = [
    {
        asks: (input) => input.op === "reshape" && input.later === true,
        feature: "reshape-later",
        refusal: (id) =>
            `The agent on "${id}" is too old to save a change for the next restart: it would restart the sandbox now instead. Nothing was changed. Update that device's agent, then save again.`,
    },
    {
        asks: (input) => input.op === "set-shape" || input.op === "forget-shape",
        feature: "set-shape",
        refusal: (id) => `The agent on "${id}" is too old to set a sandbox's shape through ic. Nothing was changed. Update that device's agent, then try again.`,
    },
    {
        asks: (input) => input.op === "prepare-background",
        feature: "background-prepare",
        refusal: (id) =>
            `The agent on "${id}" is too old to download an update in the background. Nothing was changed; its own timer still downloads updates every few hours.`,
    },
    {
        asks: (input) => input.op === "sleep",
        feature: "sleep",
        refusal: (id) => `The agent on "${id}" is too old to put a sandbox to sleep. Nothing was changed. Update that device's agent, or stop the sandbox instead.`,
    },
];

export const refuseUnsupported = (id: string, facts: Parameters<typeof deviceSupports>[0], input: DeviceSandboxFlow): void => {
    const gate = FEATURE_GATES.find((each) => each.asks(input) && !deviceSupports(facts, each.feature));
    if (gate !== undefined) {
        throw new ORPCError("CONFLICT", { message: gate.refusal(id) });
    }
};
