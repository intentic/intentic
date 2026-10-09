import { z } from "zod";
import { REPAIR_SYSTEM_PROMPT, repairToolDefinitions, REPAIR_TOOL_NAMES } from "./repair-tools.js";

const REPAIR_TOOL_NAME_SET = new Set<string>(REPAIR_TOOL_NAMES);

/** Same rule as the desktop app's `setup_link::is_slug`. */
export const isSandboxSlug = (slug: string): boolean => {
    if (slug.length < 1 || slug.length > 63) {
        return false;
    }
    const first = slug.codePointAt(0);
    if (first === undefined || !isAsciiAlphanumeric(first)) {
        return false;
    }
    for (const unit of slug) {
        const code = unit.codePointAt(0)!;
        if (!isAsciiAlphanumeric(code) && code !== `-`.codePointAt(0)! && code !== `_`.codePointAt(0)!) {
            return false;
        }
    }
    return true;
};

const isAsciiAlphanumeric = (code: number): boolean =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const toolCallSchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().refine((name) => REPAIR_TOOL_NAME_SET.has(name), { message: `unknown repair tool` }),
    arguments: z.string().max(16_000),
});

const turnMessageSchema = z
    .object({
        role: z.enum([`user`, `assistant`, `tool`]),
        content: z.string().max(16_000).optional(),
        name: z.string().max(128).optional(),
        toolCallId: z.string().max(128).optional(),
        toolCalls: z.array(toolCallSchema).max(16).optional(),
    })
    .superRefine((message, ctx) => {
        if (message.role === `assistant` && message.toolCalls !== undefined) {
            for (const call of message.toolCalls) {
                if (!REPAIR_TOOL_NAME_SET.has(call.name)) {
                    ctx.addIssue({ code: `custom`, message: `unknown repair tool`, path: [`toolCalls`] });
                }
            }
        }
        if (message.role === `tool`) {
            if (message.toolCallId === undefined || message.toolCallId.length === 0) {
                ctx.addIssue({ code: `custom`, message: `tool messages need toolCallId`, path: [`toolCallId`] });
            }
        }
    });

const contextSchema = z
    .object({
        slug: z.string().optional(),
        from: z.enum([`recovery`, `setup`, `tray`, `link`, `agents`]).optional(),
        reason: z.string().max(300).optional(),
    })
    .superRefine((context, ctx) => {
        if (context.slug !== undefined && !isSandboxSlug(context.slug)) {
            ctx.addIssue({ code: `custom`, message: `invalid sandbox slug`, path: [`slug`] });
        }
    });

export const repairTurnBodySchema = z
    .object({
        messages: z.array(turnMessageSchema).max(60).optional(),
        context: contextSchema.optional(),
    })
    .superRefine((body, ctx) => {
        let total = 0;
        for (const message of body.messages ?? []) {
            total += (message.content ?? ``).length;
            if (total > 100_000) {
                ctx.addIssue({ code: `custom`, message: `conversation too large`, path: [`messages`] });
                break;
            }
        }
    });

export type RepairTurnBody = z.infer<typeof repairTurnBodySchema>;

export const asOpenAiMessages = (body: RepairTurnBody): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [{ role: `system`, content: REPAIR_SYSTEM_PROMPT }];
    const ctx = body.context;
    if (ctx?.slug !== undefined || ctx?.reason !== undefined || ctx?.from !== undefined) {
        out.push({
            role: `system`,
            content: `The reader opened Repair from ${ctx.from ?? `unknown`}.${ctx.slug !== undefined ? ` Sandbox: ${ctx.slug}.` : ``}${ctx.reason !== undefined ? ` They saw: ${ctx.reason}` : ``}`,
        });
    }
    for (const message of body.messages ?? []) {
        if (message.role === `tool`) {
            out.push({
                role: `tool`,
                tool_call_id: message.toolCallId ?? `tool`,
                content: message.content ?? ``,
            });
            continue;
        }
        if (message.role === `assistant`) {
            const row: Record<string, unknown> = { role: `assistant`, content: message.content ?? `` };
            if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
                row[`tool_calls`] = message.toolCalls.map((call) => ({
                    id: call.id,
                    type: `function`,
                    function: { name: call.name, arguments: call.arguments },
                }));
            }
            out.push(row);
            continue;
        }
        out.push({ role: message.role, content: message.content ?? `` });
    }
    return out;
};

export { repairToolDefinitions };
