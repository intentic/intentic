import { z } from "zod";
import { TRANSLATOR_PROVIDERS, type TranslatorProvider } from "../models/provider-specs.js";
// Providers reachable via the translator (CLIProxyAPI), which holds their subscription OAuth behind an Anthropic
// endpoint; `claude` is absent, served natively. Gemini is in both camps: its native runtime reaches Google through
// this same translator. Derived from the provider table's `auth.kind`, never listed here.
export const KeyedProviderSchema = z.enum(TRANSLATOR_PROVIDERS);
export type KeyedProvider = TranslatorProvider;
