// Loopback catch: how a sign-in whose redirect lands on http://localhost:<port>/… finishes without a paste. The daemon
// is not on the machine the browser is on, so something that is (a device agent, the browser extension) watches that
// one address for the attempt's lifetime and hands back where the browser landed. Both peers answer the same
// procedure (`catchLoopback`) with the same frames, so the daemon drives them identically.
// Named imports rather than the `z` namespace: the extension bundles this module (see webext.ts).
import { discriminatedUnion, enum as zEnum, literal, number, object, string } from "zod";
import type * as z from "zod";

// What one catcher is asked to watch. The state is deliberately absent: the daemon checks it on what comes back, so a
// catcher can hold nothing that tells a real landing from a forged one, and needs nothing to.
export const LoopbackCatchSchema = object({
    // The attempt's own id, for logs on both ends; not redeemable.
    id: string().min(1),
    // The host the provider redirects to, spelled as its registration spells it: some are registered as
    // `localhost`, some as `127.0.0.1`, and a browser treats the two as different origins.
    host: zEnum(["localhost", "127.0.0.1"]),
    port: number().int().min(1).max(65535),
    // The path only, leading slash included; the query is the grant and is never matched.
    path: string().startsWith("/"),
    // Epoch ms; a catcher stops watching by itself here even if nobody aborts the stream.
    expiresAt: number(),
    // Who the page thanks once the browser lands ("Claude"), so the tab says what just happened.
    title: string().min(1),
}).strict();
export type LoopbackCatch = z.infer<typeof LoopbackCatchSchema>;

// What a catcher streams back. `busy` ends its part (the port is taken on that machine, or it cannot watch at all);
// `landed` may come more than once, since anything on the machine can hit a loopback port and only the daemon can
// tell which hit is the sign-in.
export const LoopbackCatchEventSchema = discriminatedUnion("type", [
    object({ type: literal("listening") }),
    object({ type: literal("busy"), reason: string() }),
    object({ type: literal("landed"), url: string().min(1) }),
]);
export type LoopbackCatchEvent = z.infer<typeof LoopbackCatchEventSchema>;

// Advertised in a device's `features` and a browser's facts; only a peer that says it is asked.
export const LOOPBACK_CATCH_FEATURE = "loopback-catch";

// Who is watching for this attempt's landing, for the card to say "finishes by itself on rog".
export const SignInCatcherSchema = object({
    kind: zEnum(["device", "browser"]),
    label: string().min(1),
});
export type SignInCatcher = z.infer<typeof SignInCatcherSchema>;
