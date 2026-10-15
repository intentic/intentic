import type { HostedTier } from "@intentic/constants";
import { formatCount } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// The four numbers that make a hosted machine, as the Billing page says them in the reader's language. `hostedShapeLine`
// (@intentic/constants) puts the same numbers into one English sentence for the site and the API's own errors; this is
// one localized message instead, its plural taken from the CPU count.
type MachineSize = Pick<HostedTier, `cpuKind` | `cpus` | `memoryMb` | `volumeGb`>;

export const machineWords = (size: MachineSize): string => {
    const values = { cpus: size.cpus, memory: formatCount(size.memoryMb / 1024), disk: size.volumeGb };
    return size.cpuKind === `shared`
        ? t(`settings.hostedMachine.shared`, values, size.cpus)
        : t(`settings.hostedMachine.performance`, values, size.cpus);
};
