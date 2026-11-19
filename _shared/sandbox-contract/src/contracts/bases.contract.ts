import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";
import { BaseAskSchema, BaseCheckoutSchema, BaseDropSchema, BaseEnsuredSchema } from "../schemas/bases.js";

// The `base` command on the agent's PATH drives all three on the agent token, naming its conversation by the header
// every agent CLI sends: the conversation is who holds the base. A control token never reaches them: they write
// checkouts on this sandbox's disk.
const baseRoute = procedure.meta({ agent: true, control: "never" });

export const basesContract = {
    ensure: baseRoute
        .route({
            method: "POST",
            path: "/bases",
            summary: "A read-only checkout of where this work started",
            description:
                "Answers the base for a repository at a commit (where the asking checkout leaves the main line by default), making it when none stands: a checkout of that commit outside every conversation's own, its Cargo targets seeded from a build that already ran. Shared by every conversation that asks for the same commit; it goes once none has asked for a day.",
        })
        .input(BaseAskSchema)
        .output(BaseEnsuredSchema),
    list: baseRoute
        .route({
            method: "GET",
            path: "/bases",
            summary: "The bases standing",
            description: "Every base on this sandbox's disk: its repository, commit and path, and who asked for it lately.",
        })
        .output(z.object({ bases: z.array(BaseCheckoutSchema) })),
    drop: baseRoute
        .route({
            method: "POST",
            path: "/bases/drop",
            summary: "Let go of a base",
            description: "This conversation stops holding the base it names (or every base it holds); one nobody else holds and nothing runs in is removed at once.",
        })
        .input(BaseDropSchema)
        .output(z.object({ released: z.array(z.string()), removed: z.array(z.string()) })),
};
