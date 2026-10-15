import { parseArgs } from "node:util";
import { ensureCryptoEngines } from "../signatures/engine.js";
import { trustListEvaluator } from "../signatures/trust/evaluate.js";
import { readTrustCache, refreshTrustedLists, writeTrustCache } from "../signatures/trust/lists.js";
import { verifyFile } from "../signatures/verify.js";
import { trustCachePath } from "../core/paths.js";
import { type Context, pathArgument, print, required, UsageError } from "./context.js";

// `e-urzad verify` and `e-urzad trust`: signature checks with no office connection at all. The trust chain is checked
// only against an EU trusted list fetched earlier with `e-urzad trust refresh`; without one every report says
// "trust chain not checked".

export const VERIFY_USAGE = `e-urzad verify <signature-file> [--content <signed-file>]
  XAdES (.xml, .xades), PAdES (signed .pdf), CAdES (.p7s, .p7m, .sig; detached ones need --content)
e-urzad trust refresh [--territory PL] [--territory DE]...
  fetch the EU list of trusted lists and the named countries' lists (Poland's by default), check their signatures,
  and cache them for verify
e-urzad trust status`;

export const runVerify = async (context: Context, argv: readonly string[]): Promise<void> => {
    const { values, positionals } = parseArgs({ args: [...argv], options: { content: { type: "string" } }, allowPositionals: true, strict: true });
    const file = required(positionals[0], `the signature file\n${VERIFY_USAGE}`);
    const cache = await readTrustCache(trustCachePath(context.root));
    print(context, await verifyFile(pathArgument(file), values.content === undefined ? undefined : pathArgument(values.content), trustListEvaluator(cache)));
};

export const runTrust = async (context: Context, argv: readonly string[]): Promise<void> => {
    const { values, positionals } = parseArgs({ args: [...argv], options: { territory: { type: "string", multiple: true } }, allowPositionals: true, strict: true });
    const path = trustCachePath(context.root);
    switch (positionals[0]) {
        case "refresh": {
            ensureCryptoEngines();
            const territories = (values.territory ?? ["PL"]).map((territory) => territory.toUpperCase());
            const { cache, failed } = await refreshTrustedLists({ fetcher: fetch, territories, now: context.now() });
            await writeTrustCache(path, cache);
            print(context, {
                cached: path,
                lotl: { sequence: cache.lotl.sequenceNumber, issued: cache.lotl.issued, nextUpdate: cache.lotl.nextUpdate },
                lists: cache.lists.map((list) => ({ territory: list.territory, location: list.location, sequence: list.sequenceNumber, nextUpdate: list.nextUpdate, services: list.services.length })),
                failed,
                note: "list signatures verified against the certificates the EU list of lists names; the LOTL itself is authenticated by HTTPS to ec.europa.eu, not by the Official Journal pinning",
            });
            return;
        }
        case "status": {
            const cache = await readTrustCache(path);
            print(
                context,
                cache === undefined
                    ? { cached: false, note: "no trusted list cached: verify reports 'trust chain not checked'. Run e-urzad trust refresh." }
                    : { cached: true, fetchedAt: cache.fetchedAt, lists: cache.lists.map((list) => ({ territory: list.territory, sequence: list.sequenceNumber, nextUpdate: list.nextUpdate, stale: Date.parse(list.nextUpdate) < context.now().getTime() })) },
            );
            return;
        }
        default:
            throw new UsageError(VERIFY_USAGE);
    }
};
