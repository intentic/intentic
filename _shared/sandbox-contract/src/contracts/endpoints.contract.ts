import { procedure } from "../protocol/route-meta.js";
import { z } from "zod";
import { CapabilityIdParamSchema } from "../schemas/capabilities.js";
import { ModelsSchema } from "../schemas/providers/provider-oauth.js";

// Endpoints are user-created and unbounded (unlike every other provider, which has one fixed catalog route), so the id
// rides in the path.

// The trial is an endpoint the daemon provisions rather than the user (TRIAL_ENDPOINT_ID); a separate read since
// this is a property of the account, moving with every message, not of the upstream model list.
const TrialHealthSchema = z.enum(["unknown", "healthy", "degraded", "unavailable"]);
export type TrialHealth = z.infer<typeof TrialHealthSchema>;

export const TrialStatusSchema = z.object({
    available: z.boolean(),
    allowance: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    // The shared trial pool's last real chat outcome. `unknown` means no recent turn has measured it.
    health: TrialHealthSchema,
    // ISO stamp of the next reset, absent until the platform has answered once.
    resetsAt: z.string().optional(),
    // Earliest known time a quarantined upstream key can be tried again.
    retryAt: z.string().optional(),
    // The real model that served the last trial message; the published id only names the trial ladder.
    servedModel: z.string().optional(),
});
export type TrialStatusResponse = z.infer<typeof TrialStatusSchema>;

// Whether this container can reach an NVIDIA GPU, and how sure we are. The three states are not a tri-state boolean:
// `absent` means nobody has asked yet, so the switch is still worth offering, while `unsupported` means the host's
// Docker answered and has no nvidia runtime, which is a sentence to print rather than a switch to offer. Before the
// grant the sandbox cannot see VRAM at all — only after it can `gpuMemoryBytes` be anything but zero.
export const LocalModelGpuSchema = z.enum(["granted", "unsupported", "absent"]);
export type LocalModelGpu = z.infer<typeof LocalModelGpuSchema>;

// Which one device a model runs at full speed on: the GPU when one reached this sandbox, else the host's RAM. One, never
// a sum: a model split between a card and the CPU runs at the CPU's pace.
export const LocalModelDeviceSchema = z.enum(["gpu", "host"]);
export type LocalModelDevice = z.infer<typeof LocalModelDeviceSchema>;

// One window rung priced against one model, so a surface never has to redo the arithmetic the start check will.
const LocalModelWindowFitSchema = z.object({
    tokens: z.number().int().positive(),
    // Weights + KV cache + the runtime's own floor: the same estimate the admission check refuses a start on.
    totalBytes: z.number().int().nonnegative(),
    // Whether it can load at all, GPU and host together: what a start is refused on.
    fits: z.boolean(),
    // Whether all of it fits in the free memory of the one device, so it runs at that device's pace. A rung can fit and
    // still run mostly on the CPU. Absent from a daemon older than the distinction.
    fullSpeed: z.boolean().optional(),
});

const LocalModelOptionFitSchema = z.object({
    model: z.string(),
    label: z.string(),
    tier: z.enum(["instant", "work"]),
    weightsBytes: z.number().int().nonnegative(),
    // Already in the workspace cache, so adding it costs no download; true for anything a previous card fetched.
    held: z.boolean(),
    windows: z.array(LocalModelWindowFitSchema),
});

// What the weights the connect view offers to fetch ahead of being asked for are doing right now. Read-only: the POST
// is what starts and stops it.
export const LocalModelPrefetchSchema = z.object({
    model: z.string(),
    state: z.enum(["idle", "downloading", "held", "failed"]),
    receivedBytes: z.number().int().nonnegative(),
    // Zero where the server never said how big the file is; a progress bar must not invent a denominator.
    totalBytes: z.number().int().nonnegative(),
    detail: z.string().optional(),
});
export type LocalModelPrefetch = z.infer<typeof LocalModelPrefetchSchema>;

export const LocalModelFitSchema = z.object({
    // What this container may actually use: its cgroup cap where it has one, the machine's own RAM otherwise.
    memoryBytes: z.number().int().nonnegative(),
    // True when the number above is a container limit rather than the machine's: worth saying, since the host may look
    // much larger than what a model can have.
    memoryCapped: z.boolean(),
    gpu: LocalModelGpuSchema,
    gpuMemoryBytes: z.number().int().nonnegative(),
    // The GPU's free memory, on the card with the most of it; zero before the grant. Absent from an older daemon.
    gpuFreeBytes: z.number().int().nonnegative().optional(),
    // What a start is refused on: the host and the GPU together, since llama.cpp can split a model between them. Only a
    // model that cannot load at all is turned away here; a model that fits only this way runs mostly on the CPU.
    budgetBytes: z.number().int().nonnegative(),
    // What a model may take and still run at full speed: the free memory of one device (fullSpeedDevice), plus whatever
    // this sandbox's own local model holds there now, since a start stops it first. Both offers are sized against this,
    // never against the sum. Zero means unmeasurable. Absent from a daemon older than the distinction.
    fullSpeedBytes: z.number().int().nonnegative().optional(),
    fullSpeedDevice: LocalModelDeviceSchema.optional(),
    // Whether llama-server is in this image. False means the local lane costs a rebuild before it can serve anything.
    serverReady: z.boolean(),
    options: z.array(LocalModelOptionFitSchema),
    // The two the connect view offers by name. Each is a model plus the window it was priced at, ready to be added
    // verbatim, and each runs at full speed; absent where nothing on the list does, which is an answer, not an error.
    instant: z.object({ model: z.string(), context: z.string() }).optional(),
    best: z.object({ model: z.string(), context: z.string() }).optional(),
    prefetch: LocalModelPrefetchSchema,
});
export type LocalModelFitResponse = z.infer<typeof LocalModelFitSchema>;

export const endpointsContract = {
    models: procedure
        .route({
            method: "GET",
            path: "/endpoints/{id}/models",
            summary: "Models a connected server offers",
            description:
                "Asks one configured model server what it serves. There is no built-in list and no fallback: what a server offers is knowable only by asking it, so an empty answer is the honest report that we could not.",
        })
        .input(CapabilityIdParamSchema)
        .output(ModelsSchema),
    trial: procedure
        .route({
            method: "GET",
            path: "/endpoints/trial/status",
            summary: "What is left of the free trial",
            description:
                "The allowance, what has been used, when it resets, and which model actually answered the last message. Not being available is the ordinary answer rather than a failure: most sandboxes run against a platform that offers no trial at all.",
        })
        .output(TrialStatusSchema),
    // Sized against this machine rather than a table in the browser, because the numbers that matter (a cgroup cap, a
    // GPU that may not be passed through, weights already on disk) are only knowable in here.
    localModelFit: procedure
        .route({
            method: "GET",
            path: "/endpoints/local-model/fit",
            summary: "Which local models this machine can actually run",
            description:
                "The memory this sandbox may use, whether a GPU reached it, and every curated model priced two ways: whether it fits on one device's free memory and so runs at full speed, and whether it can load at all. The two the connect view offers, one that downloads in a minute and the best this machine runs at full speed, come from the first; a start is refused only on the second.",
        })
        .output(LocalModelFitSchema),
    // Start or stop fetching the instant model's weights before anyone has asked for them, so the first local turn does
    // not begin with a download. Idempotent: starting twice joins the transfer already running.
    localModelPrefetch: procedure
        .route({
            method: "POST",
            path: "/endpoints/local-model/prefetch",
            summary: "Fetch the small model's weights ahead of being asked",
            description:
                "Downloads the curated instant model into the workspace cache so that adding it later costs nothing. Stopping leaves the part file, so a later start resumes from where this one stopped rather than beginning again.",
        })
        .input(z.object({ action: z.enum(["start", "stop"]) }))
        .output(LocalModelPrefetchSchema),
};
