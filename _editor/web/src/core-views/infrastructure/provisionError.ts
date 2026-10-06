import { t } from "@intentic/ui/i18n";

// Turn a raw sandbox/CLI error into actionable guidance for the failures the infra flow commonly hits: a
// required secret isn't set, the sandbox can't SSH to the deploy host, or the git service's Cloudflare tunnel
// has no origin yet. Everything else passes through unchanged. Shared by the plan-preview and apply-progress
// composables so a failure reads the same wherever it surfaces.
export const describeProvisionError = (raw: string): string => {
    const missing = raw.match(/missing secret env var "([^"]+)"/);
    if (missing?.[1] !== undefined) {
        return t(`views.provisionError.missingSecret`, { key: missing[1] });
    }
    if (/ECONNREFUSED|ETIMEDOUT|:22\b/.test(raw)) {
        return t(`views.provisionError.sshUnreachable`, { raw });
    }
    if (/\b(530|1033)\b|Cloudflare Tunnel/i.test(raw)) {
        return t(`views.provisionError.forgejoUnreachable`, { raw });
    }
    return raw;
};
