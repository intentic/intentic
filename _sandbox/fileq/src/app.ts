import { buildApplication, buildRouteMap } from "@stricli/core";
import { deriveCommand } from "./commands/derive.command.js";
import { readCommand } from "./commands/read.command.js";
import { sweepCommand } from "./commands/sweep.command.js";
import { version } from "./version.js";

// The agent-facing contract, kept small — this is what `fileq --help` prints.
const HELP = `fileq — binary workspace files as clean, budgeted markdown.

Reads the formats an agent cannot: docx, xlsx, pptx, pdf (text layer), images
(dimensions + EXIF), audio/video (duration + tags), html. Each workspace file
gets a markdown SIDECAR under .intentic/local/cache/derived/<path>.md, kept
fresh by content hash — reading a file twice derives once.

  fileq <file>            print it as markdown (default: read), budgeted
  fileq read <file> --budget 8000
  fileq derive <file…>    converge named files' sidecars (stale→derive, gone→remove)
  fileq sweep             converge the whole workspace, prune orphaned sidecars

Not fileq's business: plain text (read it directly), the open web (webq),
files needing OCR or transcription (later tiers say so in their sidecars).

Exit codes: 0 content, 1 nothing derivable, 2 broken invocation or install.`;

export const app = buildApplication(
    buildRouteMap({
        routes: {
            read: readCommand,
            derive: deriveCommand,
            sweep: sweepCommand,
        },
        defaultCommand: "read",
        docs: { brief: "fileq, agent-native file reading: binary files as clean budgeted markdown", fullDescription: HELP },
    }),
    {
        name: "fileq",
        versionInfo: { currentVersion: version },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        determineExitCode: () => 2,
    },
);
