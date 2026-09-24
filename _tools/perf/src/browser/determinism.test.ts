import { describeDisagreements, disagreements } from "./determinism.js";

describe("disagreements", () => {
    it("finds nothing when every run read the same", () => {
        const run = { "vue.renders": 9, "blink.layouts": 4 };
        expect(disagreements([run, { ...run }, { ...run }])).toEqual([]);
    });

    it("names each metric that moved, with every run's value in order", () => {
        const found = disagreements([
            { "vue.renders": 9, "blink.layouts": 28 },
            { "vue.renders": 9, "blink.layouts": 45 },
            { "vue.renders": 9, "blink.layouts": 28 },
        ]);
        expect(found).toEqual([{ metric: "blink.layouts", values: [28, 45, 28] }]);
    });

    it("counts a metric one run reported and another did not as a disagreement", () => {
        const found = disagreements([{ "vue.render:Icon": 3 }, {}]);
        expect(found).toEqual([{ metric: "vue.render:Icon", values: [3, undefined] }]);
        expect(describeDisagreements("agents-idle", found)).toBe("agents-idle vue.render:Icon: 3, —");
    });

    it("trusts a single run, which has nothing to disagree with", () => {
        expect(disagreements([{ "v8.calls": 1 }])).toEqual([]);
    });
});
