import { atomicToUsd, USDC_NETWORKS, usdcNetworkOf, usdToAtomic } from "./x402.js";

it("converts USD and atomic units without floats, in both directions", () => {
    expect(usdToAtomic("1.00")).toBe(1_000_000n);
    expect(usdToAtomic("0.1")).toBe(100_000n);
    expect(usdToAtomic("0.000001")).toBe(1n);
    // The classic float trap: 0.1 + 0.2 in binary floating point is not 0.3, and money must not care.
    expect(usdToAtomic("0.1") + usdToAtomic("0.2")).toBe(usdToAtomic("0.3"));
    expect(atomicToUsd(1_000_000n)).toBe("1.00");
    expect(atomicToUsd(100_000n)).toBe("0.10");
    expect(atomicToUsd(1n)).toBe("0.000001");
});

it("reads a bare whole or fraction, cuts past the sixth decimal, and writes zero as cents", () => {
    expect(usdToAtomic("5")).toBe(5_000_000n);
    expect(usdToAtomic(".5")).toBe(500_000n);
    expect(usdToAtomic("0.0000019")).toBe(1n);
    expect(atomicToUsd(0n)).toBe("0.00");
    expect(atomicToUsd(12_345_670n)).toBe("12.34567");
});

it("knows USDC on Base and Base Sepolia by CAIP-2 id, and nothing else", () => {
    expect(USDC_NETWORKS.map(({ network, chainId, asset }) => [network, chainId, asset])).toEqual([
        ["eip155:8453", 8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
        ["eip155:84532", 84532, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
    ]);
    expect(usdcNetworkOf("eip155:84532")?.v1Network).toBe("base-sepolia");
    expect(usdcNetworkOf("base")).toBeUndefined();
});
