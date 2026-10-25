import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";
import { ArtifactNameSchema } from "./device-artifacts.js";

// <repo>/.intentic/run.json declares tracked targets shared by devices run <target> and the editor's Run on <device> terminal command.
// Each explicit run builds in the sandbox, pushes artifacts, reaches the declared device ports and starts the program via app_start.
// Targets name device, build, artifact mappings and program; declaring one never starts it automatically.

export const RUN_TARGETS_FILE = `${STATE_DIR}/run.json`;

const RepoPathSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "a path inside the repository, relative to its root");
const BundleNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199})*$/, "a relative name, folders by /");

export const RunTargetSchema = z
    .object({
        // What `devices run <name>` and the button call it.
        name: ArtifactNameSchema,
        description: z.string().max(300).optional(),
        // The computer it runs on unless one is named at the run; the device's name as its tools are mounted.
        device: z.string().min(1).max(100).optional(),
        // A shell command run from the repository's root, in the sandbox, before every run; absent means the artifact
        // is already there.
        build: z.string().min(1).max(4000).optional(),
        // What is carried: one file or one folder, or a set of files and folders gathered into one folder under names of
        // their own (an .exe beside the sidecars, DLLs and resource folders it looks for next to itself).
        artifact: z.union([RepoPathSchema, z.record(BundleNameSchema, RepoPathSchema)]),
        // Which file to start when the artifact is a folder or a set; a lone file is started as itself.
        program: BundleNameSchema.optional(),
        args: z.array(z.string().max(4000)).max(100).default([]),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).default({}),
        // Run it inside Windows Sandbox, a throwaway VM that sees the build read-only and nothing else of the machine.
        isolated: z.boolean().default(false),
        // The device's own loopback ports the sandbox needs to reach while it runs (its local API, a dev server), each
        // opened at the same port in the sandbox.
        reach: z.array(z.int().min(1).max(65535)).max(16).default([]),
    })
    .strict();
export type RunTarget = z.infer<typeof RunTargetSchema>;

export const RunTargetsFileSchema = z
    .object({
        targets: z
            .array(RunTargetSchema)
            .min(1)
            .max(50)
            .refine((targets) => new Set(targets.map((target) => target.name)).size === targets.length, "two targets share a name"),
    })
    .strict();

// One repository's file as the editor lists it: its targets, or what is wrong with the file.
export const RepoRunTargetsSchema = z.object({
    repo: z.string(),
    path: z.string(),
    targets: z.array(RunTargetSchema),
    error: z.string().optional(),
});

export const RunTargetsListSchema = z.object({
    repos: z.array(RepoRunTargetsSchema),
    // The owner's computers: whether each is connected, whether its agent is new enough to take a program, and whether
    // its card's "Run programs this sandbox sends" switch is on. A run needs all three.
    devices: z.array(z.object({ id: z.string(), online: z.boolean(), programs: z.boolean(), allowed: z.boolean() })),
});
export type RunTargetsList = z.infer<typeof RunTargetsListSchema>;

export const RunStartSchema = z.object({
    repo: z.string().min(1),
    target: ArtifactNameSchema,
    device: z.string().min(1).max(100),
});
export type RunStart = z.infer<typeof RunStartSchema>;

// The terminal session the run is in, for the editor to open.
export const RunStartedSchema = z.object({ session: z.string() });
