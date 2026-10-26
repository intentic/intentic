import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import { t } from "../i18n.js";

export const serviceSummary = (service: Service, profiles: readonly AccessProfileEntry[]): string => {
    const profile = profiles.find((entry) => entry.id === service.profile);
    const parts = [t(`service.steward`, { email: service.steward })];
    if (service.brief) {parts.push(service.brief);}
    if (!service.profile) {return [...parts, t(`service.stewardLimits`)].join(` · `);}
    if (!profile) {return [...parts, t(`service.profileUnavailable`, { id: service.profile })].join(` · `);}
    parts.push(profile.label ?? profile.id);
    const tools = profile.tools;
    if (tools?.files === `none`) {parts.push(t(`service.noFiles`));}
    if (tools?.files === `read`) {parts.push(t(`service.readFiles`));}
    for (const shelf of [`shell`, `code`, `web`, `browser`, `delegate`, `sandbox`] as const) {
        if (tools?.[shelf] === false) {parts.push(t(`service.tools.${shelf}`));}
    }
    parts.push(profile.credentials === undefined ? t(`service.allConnections`) : t(`service.connections`, { count: profile.credentials.capabilities.length }));
    parts.push(t(`service.aiAccounts`, { accounts: profile.aiAccounts === undefined ? t(`service.all`) : profile.aiAccounts.join(`, `) || t(`service.none`) }));
    return parts.join(` · `);
};
