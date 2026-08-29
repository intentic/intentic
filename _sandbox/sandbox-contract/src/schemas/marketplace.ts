// The extension marketplace request and its answer.
import { z } from "zod";
import { RegistryEntrySchema } from "@intentic/registry";
// Browse an extension/plugin registry (a git repo with .claude-plugin/marketplace.json, see
// @intentic/registry for the format). POST so the optional token for a private registry never rides a URL or
// an access log.
export const MarketplaceRequestSchema = z.object({
    url: z.url().describe("The registry to read."),
    token: z
        .string()
        .min(1)
        .optional()
        .describe("A credential for a private one. Sent as a body rather than in the address, so it never lands in a log."),
});
// The rows are RegistryEntry, the curated decision joined to the resolved pointer and the scanner's upstream
// facts, exactly as the site's gallery renders them, so browsing in the app and browsing the web show one list.
export const MarketplaceSchema = z.object({
    name: z.string().describe("What the registry calls itself."),
    plugins: z
        .array(RegistryEntrySchema)
        .describe("What it lists, each with the curated decision, the resolved pointer and what a scan found upstream."),
});
export type Marketplace = z.infer<typeof MarketplaceSchema>;
