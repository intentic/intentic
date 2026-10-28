import { formatClock, formatDayMonthTime } from "@intentic/ui/format";
import { providerRefusals } from "../../../models/providers/providerAccounts";
import { accountOffLine } from "./accountOff";

// An account its organization or plan turned off, as its row says it at a glance: off, by whom, since when, and then the
// provider's own words, which the row's hover keeps whole.

const SAID = `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access`;
const NOW = new Date(2026, 9, 28, 15, 0).getTime();

afterEach(() => {
    providerRefusals.value = {};
});

describe(`accountOffLine`, () => {
    it(`leads with off and who turned it off, then the provider's words`, () => {
        expect(accountOffLine(`claude`, `Claude Code`, `work`, SAID, NOW)).toBe(`Off: its organization or plan turned off Claude Code · ${SAID}`);
    });

    it(`says since when, by the clock for today and the day before that, from the newest refusal on this account`, () => {
        const today = NOW - 40 * 60_000;
        providerRefusals.value = {
            claude: [
                { at: today - 3_600_000, kind: `entitlement`, message: SAID, account: `work` },
                { at: today, kind: `entitlement`, message: SAID, account: `work` },
                { at: NOW - 60_000, kind: `entitlement`, message: SAID, account: `home` },
            ],
        };
        expect(accountOffLine(`claude`, `Claude Code`, `work`, SAID, NOW)).toBe(`Off: its organization or plan turned off Claude Code · since ${formatClock(today)} · ${SAID}`);
        const lastWeek = NOW - 5 * 86_400_000;
        providerRefusals.value = { claude: [{ at: lastWeek, kind: `entitlement`, message: SAID, account: `work` }] };
        expect(accountOffLine(`claude`, `Claude Code`, `work`, ``, NOW)).toBe(`Off: its organization or plan turned off Claude Code · since ${formatDayMonthTime(lastWeek)}`);
    });
});
