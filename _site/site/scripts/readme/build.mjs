// Builds every picture the repository README shows, into docs/marketing/readme/: photographs the demo build, then
// frames the photographs and draws the diagrams in the site's carved style, once per GitHub colour scheme.
//
//   pnpm -C _site/demo dev                                # the demo, on :47146
//   pnpm -C _site/site readme                             # capture, then compose
//   pnpm -C _site/site readme compose                     # re-frame the last capture only
//   DEMO_URL=http://127.0.0.1:47148/demo pnpm -C _site/site readme capture board plan
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./capture.mjs";
import { compose } from "./compose.mjs";

const [step = "all", ...only] = process.argv.slice(2);
const demoUrl = process.env.DEMO_URL ?? "http://127.0.0.1:47146/demo";
const rawDir = process.env.README_RAW ?? join(tmpdir(), "intentic-readme-raw");
const outDir = join(import.meta.dirname, "../../../../docs/marketing/readme");

if (step === "all" || step === "capture") {
    console.log(`capturing from ${demoUrl} into ${rawDir}`);
    await capture({ demoUrl, outDir: rawDir, only });
}
if (step === "all" || step === "compose") {
    console.log(`composing into ${outDir}`);
    await compose({ rawDir, outDir, only });
}
