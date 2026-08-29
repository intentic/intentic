import { z } from "zod";
// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent, native Anthropic OAuth serves it directly, without the translator. Codex, Grok and Gemini also have a
// native runtime and so carry the harness axis; Kimi is routed-only, so its turns always use Claude Code.
//
// Gemini is in BOTH camps and that is not a contradiction: its native runtime (OpenCode) reaches Google through
// this same translator and these same auth files. The harness axis picks the loop; the translator is the road
// under either.
export const KeyedProviderSchema = z.enum(["codex", "grok", "kimi", "gemini"]);
export type KeyedProvider = z.infer<typeof KeyedProviderSchema>;
