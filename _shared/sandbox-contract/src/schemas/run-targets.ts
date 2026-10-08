import { z } from "zod";
import { ArtifactNameSchema } from "./device-artifacts.js";

// WHAT A REPOSITORY SAYS IT CAN BE RUN AS, ON ONE OF THE OWNER'S COMPUTERS (`<repo>/.intentic/run.json`). Beside the
// build scripts it names and tracked with them, like `.intentic/checks.json`. One file serves two doors that must do the
// same thing: an agent's `devices run <target>` in its own shell, and the editor's "Run on <device>" button, which runs
// that very command in a terminal the owner watches. Each run builds in the sandbox, carries the build to the device
// (`devices push`), opens the device ports the target says the sandbox needs (`devices reach`), and starts the program
// there (the device's app_start). Nothing here runs by itself: a target runs when someone runs it.
//
//   {
//     "targets": [{
//       "name": "desktop",
//       "device": "rog",
//       "build": "bash _tools/scripts/desktop/build-desktop.sh 0.0.0 --windows-only",
//       "artifact": {
//         "intentic-desktop.exe": "_editor/desktop-app/src-tauri/target/x86_64-pc-windows-msvc/release/intentic-desktop.exe",
//         "intentic-files.exe": "_editor/desktop-app/src-tauri/binaries/intentic-files-x86_64-pc-windows-msvc.exe"
//       },
//       "program": "intentic-desktop.exe"
//     }]
//   }

export const RUN_TARGETS_FILE = ".intentic/run.json";

const RepoPathSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "a path inside the repository, relative to its root");
const BundleNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199})*$/, "a relative name, folders by /");

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
