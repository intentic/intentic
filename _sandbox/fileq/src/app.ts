import { packageVersion } from "@intentic/agent-cli/version";
import { buildApplication, buildRouteMap } from "@stricli/core";
import { checkCommand } from "./commands/check.command.js";
import { deriveCommand } from "./commands/derive.command.js";
import { gitAttributesCommand } from "./commands/git-attributes.command.js";
import { readCommand } from "./commands/read.command.js";
import { renderCommand } from "./commands/render.command.js";

// The agent-facing contract, kept small — this is what `fileq --help` prints.
const HELP = `fileq — binary workspace files as clean, budgeted markdown.

Reads the formats an agent cannot: docx, xlsx, pptx, pdf (text layer), images
(dimensions + EXIF), audio/video (duration + tags), html. Renderings are cached
by content hash, so reading unchanged bytes again (the same file, a copy, a
download outside the workspace) is instant; each workspace file also gets a
markdown SIDECAR under .intentic/local/cache/derived/<path>.md.

  fileq <file>            print it as markdown (default: read), budgeted
  fileq read <file> --budget 8000
  fileq derive <file…>    converge named files' sidecars (stale→derive, gone→remove)
  fileq read --plain <f>  the markdown alone, for a program; git's textconv driver
  fileq git-attributes    the gitattributes that route documents through it

After producing a document, check it and look at it:

  fileq check <file>      docx, pptx, xlsx, pdf: problems a reader would meet, each
                          with its slide, page, cell or paragraph; exit 1 on an error
  fileq render <file> [--pages 1-3] [--out <dir>]
                          pages or slides as PNG files, one path per line, for an
                          image reader (office formats need LibreOffice; all need
                          pdftoppm or mutool)

git diff, git show and git log -p on a document print its text, not "Binary
files differ": the sandbox names every derivable extension diff=fileq.

Not fileq's business: plain text (read it directly), the open web (webq),
files needing OCR or transcription (later tiers say so in their sidecars).

Exit codes: 0 content, 1 nothing derivable (check: an error found), 2 broken
invocation or install (render: a tool it needs is missing).`;

export const app = buildApplication(
    buildRouteMap({
        routes: {
            read: readCommand,
            check: checkCommand,
            render: renderCommand,
            derive: deriveCommand,
            gitAttributes: gitAttributesCommand,
        },
        defaultCommand: "read",
        docs: { brief: "fileq, agent-native file reading: binary files as clean budgeted markdown", fullDescription: HELP },
    }),
    {
        name: "fileq",
        versionInfo: { currentVersion: packageVersion(import.meta.url) },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        determineExitCode: () => 2,
    },
);
