import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";
import { streamOf } from "../protocol/routes.js";
import { OffloadFrameSchema, OffloadKindSchema, OffloadRecordSchema, OffloadRunSchema, OffloadTargetSchema } from "../schemas/offload.js";
import { OkSchema } from "../schemas/shared.js";

// The in-sandbox `offload-run` command drives the first three on the agent token: the Bash hook and the check after
// landing put it in front of a heavy line whose kind the owner sends to a runner (settings `offload`). A control token
// never reaches them: they run code on another machine.
const offloadRoute = procedure.meta({ agent: true, control: "never" });

export const offloadContract = {
    target: offloadRoute
        .route({
            method: "GET",
            path: "/offload/runners/{runner}",
            summary: "Whether a runner can take a heavy command",
            description:
                "Answers whether the runner a kind of heavy work is sent to is connected and able to run it, before anything is copied to it. When it is not, the command runs in this sandbox and says why.",
        })
        .input(z.object({ runner: z.string().min(1) }))
        .output(OffloadTargetSchema),
    run: offloadRoute
        .route({
            method: "POST",
            path: "/offload/runs",
            summary: "Run a heavy command on a runner",
            description:
                "Hands one command to a runner on one of your machines, together with a snapshot of the code as it stands, and streams its output back as it comes. It ends with the exit code, every file the command changed and any report it wrote.",
        })
        .meta({ stream: true })
        .input(OffloadRunSchema)
        .output(streamOf(OffloadFrameSchema)),
    cancel: offloadRoute
        .route({
            method: "POST",
            path: "/offload/runs/{runId}/cancel",
            summary: "Stop an offloaded command",
            description: "Stops a command running on a runner, with everything it started there.",
        })
        .input(z.object({ runId: z.string().min(1) }))
        .output(OkSchema),
    kinds: procedure
        .route({
            method: "GET",
            path: "/offload/kinds",
            summary: "Kinds of heavy work that can run elsewhere",
            description:
                "The kinds this sandbox sorts heavy commands into (tests, typechecks, verify…), each of which can be sent to a runner on one of your machines instead of running here.",
        })
        .output(z.object({ kinds: z.array(OffloadKindSchema) })),
    runs: procedure
        .route({
            method: "GET",
            path: "/offload/runs",
            summary: "Recent offloaded commands",
            description: "The heavy commands this sandbox sent to runners lately, newest first, with where they ran and how they ended.",
        })
        .output(z.object({ runs: z.array(OffloadRecordSchema) })),
};
