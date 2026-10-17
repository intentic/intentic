import { t } from "@intentic/ui/i18n";

// allow(dependency-text): Node's errno codes, Go's and OpenSSH's address wording; an unmatched one is shown raw.
// Port 22 counts only where an address or the word "port" names it, never a clock's 10:22 or a file.ts:22.
const SSH_UNREACHABLE = /ECONNREFUSED|ETIMEDOUT|\b(?:tcp|udp)\s+\S*:22(?!\d)|\d{1,3}(?:\.\d{1,3}){3}:22(?!\d)|\]:22(?!\d)|\bport 22\b/;
// allow(dependency-text): Cloudflare's tunnel answer (HTTP 530, its page's "Error 1033"); an unmatched one is shown raw.
// The numbers count only as a status or an error code, never a count or a line that happens to be 530.
const TUNNEL_DOWN = /\b(?:status(?: code)?|HTTP(?:\/[\d.]+)?)\s*:?\s*530\b|\berror\s*(?:code\s*)?:?\s*1033\b|Cloudflare Tunnel/i;

// Turn a raw sandbox/CLI error into actionable guidance for the failures the infra flow commonly hits: a
// required secret isn't set, the sandbox can't SSH to the deploy host, or the git service's Cloudflare tunnel
// has no origin yet. Everything else passes through unchanged. Shared by the plan-preview and apply-progress
// composables so a failure reads the same wherever it surfaces.
export const describeProvisionError = (raw: string): string => {
    const missing = raw.match(/missing secret env var "([^"]+)"/);
    if (missing?.[1] !== undefined) {
        return t(`views.provisionError.missingSecret`, { key: missing[1] });
    }
    if (SSH_UNREACHABLE.test(raw)) {
        return t(`views.provisionError.sshUnreachable`, { raw });
    }
    if (TUNNEL_DOWN.test(raw)) {
        return t(`views.provisionError.forgejoUnreachable`, { raw });
    }
    return raw;
};
