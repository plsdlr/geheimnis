export interface GeheimisParams {
  N: number;         // plaintext field elements
  P: number;         // padded length (next multiple of 3)
  C: number;         // ciphertext length = P + 1
  S_t: number;       // public signals for transfer proof (2C + 5)
  S_a: number;       // public signals for addData proof (2C + 6)
  ptauPower: number; // minimum power of tau needed
}

export interface ProjectConfig extends GeheimisParams {
  name: string;
  symbol: string;
  outputDir: string;
  // Public minting — only set when hasMintLogic = true
  hasMintLogic: boolean;
  maxSupply?: number;
  mintPrice?: string; // in ETH, e.g. "0.05"
}

export function computeParams(N: number): GeheimisParams {
  const P = Math.ceil(N / 3) * 3;
  const C = P + 1;
  const S_t = 2 * C + 5;
  const S_a = 2 * C + 6;

  // Constraint estimate (transfer circuit — the larger of the two):
  //   BabyPbk: ~3,800  |  ECDH ×2: ~15,200  |  PoseidonEncrypt+Decrypt(N): ~600×ceil(N/3)
  //   Total ≈ 22,800 + 600×ceil(N/3)
  // Add 20% headroom so snarkjs doesn't reject due to rounding.
  const estimatedConstraints = Math.ceil((22800 + 600 * Math.ceil(N / 3)) * 1.2);
  const ptauPower = Math.ceil(Math.log2(estimatedConstraints));

  return { N, P, C, S_t, S_a, ptauPower };
}

// Powers-of-tau Hermez ceremony files (BN254, 28 max)
export function ptauUrl(power: number): string {
  const padded = String(power).padStart(2, '0');
  return `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${padded}.ptau`;
}
