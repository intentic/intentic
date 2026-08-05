import { fileURLToPath } from "node:url";
import { Eta } from "eta";

// Generated files (Forgejo Actions YAML, scaffolded TS/Dockerfile, access.md, .env.example) are rendered from
// .eta templates instead of hand-concatenated strings, so a stray space or newline can't silently break the
// output. Templates ship beside dist/ at the package root (package.json "files": ["dist", "templates"]) — never
// under src/, which tsc would not copy. This module lives at <root>/{src,dist}/lib/templates.{ts,js}, so the
// package root (and its templates/) is two levels up in BOTH the source (vitest) and compiled (shipped) layouts.
const views = fileURLToPath(new URL("../../templates", import.meta.url));

// autoEscape OFF: we render YAML / TS / Markdown / dotenv, never HTML — HTML-escaping would corrupt `${{ … }}`,
// quotes, and angle brackets. autoTrim OFF: the output is whitespace-sensitive (YAML especially), so each
// template's bytes are emitted verbatim and trimming is controlled explicitly with `-%>` where a loop needs it.
const eta = new Eta({ views, autoEscape: false, autoTrim: false });

// Render a template by path under templates/ (without the .eta extension), e.g. "workflows/resolve.yaml". The
// .eta suffix is appended here — Eta only auto-appends its default extension when the name has none, and ours
// carry the output extension (.yaml/.ts/.md) so the files are readable/highlighted as what they produce.
export const renderTemplate = (name: string, data: Record<string, unknown>): string => eta.render(`${name}.eta`, data);
