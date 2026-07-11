// Turn a raw sandbox/CLI error into actionable guidance for the failures the infra flow commonly hits: a
// required secret isn't set, the sandbox can't SSH to the deploy host, or the git service's Cloudflare tunnel
// has no origin yet. Everything else passes through unchanged. Shared by the plan-preview and apply-progress
// composables so a failure reads the same wherever it surfaces.
export const describeProvisionError = (raw: string): string => {
    const missing = raw.match(/missing secret env var "([^"]+)"/);
    if (missing?.[1] !== undefined) {
        return `The deploy needs a value for ${missing[1]} that isn't set yet — set it below (or on the Secrets page), then apply again.`;
    }
    if (/ECONNREFUSED|ETIMEDOUT|:22\b/.test(raw)) {
        return `${raw} — the sandbox couldn't reach the deploy host over SSH. Make sure the host's SSH tunnel is up (re-run the connect script) and its deploy target is reachable.`;
    }
    if (/\b(530|1033)\b|Cloudflare Tunnel/i.test(raw)) {
        return `${raw} — the git service (Forgejo) isn't reachable yet; its Cloudflare tunnel has no live origin. This usually clears once "apply" finishes deploying it, so retry in a moment.`;
    }
    return raw;
};
