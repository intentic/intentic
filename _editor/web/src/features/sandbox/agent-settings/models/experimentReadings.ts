import type { TurnExperiment } from "@intentic/sandbox-contract";
import { meanUnit, verdictsOf } from "../../usage/savingsChart";
import type { PanelReading } from "./MeasurementPanel.vue";

// One experiment as the panel draws it: the headline verdict, then its other readings, each with the arms behind it.
export const readingsOf = (experiment: TurnExperiment | undefined): PanelReading[] => {
    if (experiment === undefined) {
        return [];
    }
    const { headline, also } = verdictsOf(experiment);
    return [headline, ...also].flatMap((verdict, index) => {
        const reading = experiment.metrics[index];
        return reading === undefined ? [] : [{ verdict, on: reading.on, off: reading.off, meanUnit: meanUnit(reading) }];
    });
};
