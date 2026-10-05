import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { sendMail } from "../mail.js";
import { adminAttention } from "./admin-attention.js";

// Attention feed pushed once a day rather than waiting to be pulled. Sends only when there is something to say, only to
// ADMIN_EMAILS, at most once per UTC day (latched on the rollup row's `digestAt`, stamped before send).

const TOP_ITEMS = 12;

/* A LINE ONE OF THE DAY'S SWEEPS HAS FOR A HUMAN, beside the attention feed's rows (2026-10-05): what the reapers left
 * standing because nothing proves it gone (apps of sandboxes this database has no record of), what they refused or put
 * off, and what the app-shape check would not touch. Mail-only: the feed's rows come from the database, while these
 * exist only in the pass that found them, so they ride the digest that pass sends. */
export interface AdminDigestLine {
    readonly severity: `danger` | `warning`;
    readonly title: string;
    readonly detail?: string;
}

export const sendAdminDigest = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    day: string,
    now: () => Date = () => new Date(),
    extra: readonly AdminDigestLine[] = [],
): Promise<void> => {
    const admins = config.admin.emails
        .split(`,`)
        .map((email) => email.trim())
        .filter((email) => email !== ``);
    if (admins.length === 0) {
        return;
    }
    // A conditional update wins the once-per-day latch exactly once even if two replicas raced past the job lock.
    const latch = await prisma.adminDailyStat.updateMany({ where: { day, digestAt: null }, data: { digestAt: now() } });
    if (latch.count === 0) {
        return;
    }
    const attention = await adminAttention(prisma, now);
    // The sweeps' own lines first: they are this morning's, and the feed's rows are in the panel anyway.
    const items: readonly AdminDigestLine[] = [...extra, ...attention.items];
    if (items.length === 0) {
        return;
    }
    const dangers = items.filter((item) => item.severity === `danger`).length;
    const subject = `intentic admin: ${items.length} ${items.length === 1 ? `item needs` : `items need`} a human${dangers > 0 ? ` (${dangers} urgent)` : ``}`;
    const lines = items
        .slice(0, TOP_ITEMS)
        .map(
            (item) =>
                `<li style="margin: 0.4rem 0;">${item.severity === `danger` ? `🔴` : `🟡`} ${item.title}${item.detail ? `<br/><span style="color:#888; font-size: 0.85rem;">${item.detail}</span>` : ``}</li>`,
        )
        .join(``);
    const more = items.length > TOP_ITEMS ? `<p style="color:#888;">…and ${items.length - TOP_ITEMS} more in the panel.</p>` : ``;
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
    logger.info({ day, items: items.length, dangers, admins: admins.length }, `admin digest sent`);
};
