// The longest one message may be on each platform, declared once: the approvals inbox counts a post against it (over it,
// a post does not post), the daemon refuses a direct publish past it, and each messaging gateway spills a reply into a
// follow-up message there. Measured in JavaScript string length (UTF-16 code units), which never undercounts a
// platform that counts characters. A platform absent here has no known cap.
export const MESSAGE_LIMITS = {
    bluesky: 300,
    discord: 2_000,
    instagram: 2_200,
    linkedin: 3_000,
    mastodon: 500,
    // Slack's own advice is to keep a message under 4,000 characters; past 40,000 it truncates.
    slack: 4_000,
    // sendMessage refuses anything longer outright.
    telegram: 4_096,
    // A linked device (what the WhatsApp extension is) sends up to 65,536; the 4,096 often quoted is the Business API's.
    whatsapp: 65_536,
    x: 280,
    youtube: 5_000,
} as const satisfies Readonly<Record<string, number>>;

// `platform` is a bare string by contract, matched case-insensitively. A Map, so only the table's own keys answer: a
// record lookup answered `constructor` with Object.prototype's function.
const LIMITS = new Map<string, number>(Object.entries(MESSAGE_LIMITS));

export const messageLimitOf = (platform: string): number | undefined => LIMITS.get(platform.toLowerCase());
