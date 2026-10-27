import type { GroupSamples } from "./context.ts";

// A loop is started on a fresh conversation and stopped before its first round.
export const loopsSamples: GroupSamples<`loops`> = ({ loop }) => ({
    designs: undefined,
    saveDesign: { design: loop, create: false },
    removeDesign: { id: loop.id },
    start: {
        conversationId: `smoke-loop`,
        goal: `The suite passes`,
        prompt: `Run the tests, take the top failure, fix it.`,
        context: loop.context,
        output: loop.output,
        checks: loop.checks,
        maxIterations: loop.maxIterations,
        stallLimit: loop.stallLimit,
        isolated: false,
    },
    stop: { conversationId: `smoke-loop` },
});
