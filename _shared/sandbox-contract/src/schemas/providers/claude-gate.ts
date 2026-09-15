import { z } from "zod";
// The GATE signal: whether the provider is letting turns through right now, and, when it is refusing, which
// window is binding and when it lifts. This is the SDK's rate_limit_event, mapped one-to-one, and it is only
// ever about the CURRENT moment. It is deliberately NOT the thing the headroom displays read: the event names a
// single window (whichever the CLI considered binding), which is how "weekly 1%" ended up standing in for an
// account that was really at 98% on another weekly pool.
export const RateLimitInfoSchema = z.object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    resetsAt: z.number().optional(), // epoch seconds
    rateLimitType: z.string().optional(), // 'five_hour' | 'seven_day' | 'seven_day_opus' | ...
    utilization: z.number().optional(), // 0-100, how much of the window is used
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;
