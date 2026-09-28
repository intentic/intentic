import { eventIterator } from "@orpc/contract";
import type * as z from "zod";

// Every streamed route declares its frames through this, never oRPC's `eventIterator` directly: that returns an opaque
// standard-schema validator holding no reachable inner schema, so a stream's payload would be unfingerprintable and its
// drift invisible. The frame schema rides along under a symbol, which oRPC never reads and JSON never serializes.
// Typed as a plain `symbol`, not the inferred unique one: a unique symbol would ride into every contract's inferred
// type and break declaration emit on a local name nothing outside can refer to.
// Its own module, apart from routes.ts, because the browser extension's contract streams too and routes.ts reaches
// zod's namespace at runtime, which the extension's bundle budget cannot carry.
export const FRAME: symbol = Symbol.for("intentic.contract.frame");

export const streamOf = <T extends z.ZodType>(frame: T) => Object.assign(eventIterator(frame), { [FRAME]: frame });
