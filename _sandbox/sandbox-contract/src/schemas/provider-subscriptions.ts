import { z } from "zod";
import { TRANSLATOR_PROVIDERS, type TranslatorProvider } from "../provider-specs.js";
// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent, native Anthropic OAuth serves it directly, without the translator. Codex, Grok and Gemini also have a
// native runtime and so carry the harness axis; Kimi is routed-only, so its turns always use Claude Code.
//
// Gemini is in BOTH camps and that is not a contradiction: its native runtime (OpenCode) reaches Google through
// this same translator and these same auth files. The harness axis picks the loop; the translator is the road
// under either.
//
// DERIVED from the provider table's `auth.kind`, never listed here: this enum and the accounts schema built on
// it (TranslatorAccountsSchema) and the daemon's CLIProxyAPI id map are three readings of one fact, and they
// used to be three hand-kept lists that had to agree.
export const KeyedProviderSchema = z.enum(TRANSLATOR_PROVIDERS);
export type KeyedProvider = TranslatorProvider;
