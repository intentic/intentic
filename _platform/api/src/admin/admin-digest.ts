import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { sendMail } from "../mail.js";
import { adminAttention } from "./admin-attention.js";

/* THE OPERATOR'S MORNING MAIL — the attention feed, pushed once a day instead of waiting to be pulled. The
 * panel answers "what needs me" only when somebody opens it; a stuck payout on a week the operator is busy
 * elsewhere waits exactly as long as their curiosity does, which is the failure mode this closes.
 *
 * Sends ONLY when there is something to say (an empty feed mails nobody), only to the ADMIN_EMAILS list,
 * and at most once per UTC day — the latch is the rollup row's `digestAt`, stamped before the send so a
 * crash mid-send costs one digest rather than sending doubles forever. Rides the same Resend path as
 * invites; an unconfigured mailer logs and moves on, exactly like every other mail on this platform. */

const TOP_ITEMS = 12;

export const sendAdminDigest = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    day: string,
    now: () => Date = () => new Date(),
): Promise<void> => {
    const admins = config.admin.emails
        .split(`,`)
        .map((email) => email.trim())
        .filter((email) => email !== ``);
    if (admins.length === 0) {
        return;
    }
    // The once-per-day latch. A conditional update wins exactly once even if two replicas raced past the
    // job lock; losing it means somebody else is sending, which is the desired outcome.
    const latch = await prisma.adminDailyStat.updateMany({ where: { day, digestAt: null }, data: { digestAt: now() } });
    if (latch.count === 0) {
        return;
    }
    const attention = await adminAttention(prisma, config, now);
    if (attention.items.length === 0) {
        return;
    }
    const dangers = attention.items.filter((item) => item.severity === `danger`).length;
    const subject = `intentic admin: ${attention.items.length} ${attention.items.length === 1 ? `item needs` : `items need`} a human${dangers > 0 ? ` (${dangers} urgent)` : ``}`;
    const lines = attention.items
        .slice(0, TOP_ITEMS)
        .map(
            (item) =>
                `<li style="margin: 0.4rem 0;">${item.severity === `danger` ? `🔴` : `🟡`} ${item.title}${item.detail ? `<br/><span style="color:#888; font-size: 0.85rem;">${item.detail}</span>` : ``}</li>`,
        )
        .join(``);
    const more = attention.items.length > TOP_ITEMS ? `<p style="color:#888;">…and ${attention.items.length - TOP_ITEMS} more in the panel.</p>` : ``;
    const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 34rem; margin: 0 auto; color: #1a1a1a;">
        <h2 style="font-size: 1.15rem; font-weight: 600;">The platform's attention feed, ${day}</h2>
        <ul style="padding-left: 1.1rem; line-height: 1.45;">${lines}</ul>
        ${more}
        <p style="color: #888; font-size: 0.8rem;">Sent because ADMIN_EMAILS lists you. The full feed, and who each row belongs to, is in the Platform admin panel.</p>
    </div>`;
    for (const to of admins) {
        try {
            await sendMail(config, logger, { to, subject, link: config.webOrigin, html });
        } catch (error) {
            // One bad address must not cost the other admins their digest; tomorrow retries everybody.
            logger.error({ err: error, to }, `admin digest send failed`);
        }
    }
    logger.info({ day, items: attention.items.length, dangers, admins: admins.length }, `admin digest sent`);
};
