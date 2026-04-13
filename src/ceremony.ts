/**
 * Multi-party ceremony support for Geheimnis.
 *
 * Flow:
 *   1. Deployer runs `geheimnis ceremony init <project-dir>`
 *      → produces Transfer_0000.zkey + AddData_0000.zkey
 *      → writes ceremony/state.json tracking contributor chain
 *
 *   2. Each contributor runs `geheimnis ceremony contribute <zkey>`
 *      → prompted for optional personal entropy (combined with CSPRNG)
 *      → outputs next numbered zkey, prints contribution hash to verify
 *
 *   3. Deployer runs `geheimnis ceremony finalize <project-dir>`
 *      → applies final random beacon (CSPRNG)
 *      → exports vkey.json + Groth16Verifier*.sol for deployment
 *      → runs snarkjs zkey verify to confirm transcript
 *
 *   4. Anyone can run `geheimnis ceremony verify <project-dir>`
 *      → re-runs snarkjs zkey verify and prints contribution chain
 */

import { execa } from 'execa';
import { randomBytes, createHash } from 'crypto';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNARKJS_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin', 'snarkjs');

// ─── State file ───────────────────────────────────────────────────────────────

export interface ContributionRecord {
  index: number;       // 0000, 0001, …
  name: string;
  contributionHash: string;
  timestamp: string;
}

export interface CeremonyState {
  circuits: string[];                          // e.g. ['Transfer', 'AddData']
  r1csPaths: Record<string, string>;
  ptauPath: string;
  contributions: ContributionRecord[];
  finalized: boolean;
}

const STATE_FILE = 'ceremony/state.json';

async function readState(projectDir: string): Promise<CeremonyState> {
  const raw = await readFile(path.join(projectDir, STATE_FILE), 'utf-8');
  return JSON.parse(raw);
}

async function writeState(projectDir: string, state: CeremonyState): Promise<void> {
  await writeFile(path.join(projectDir, STATE_FILE), JSON.stringify(state, null, 2));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export interface InitOptions {
  projectDir: string;
  buildDir: string;
  ptauPath: string;
  circuits: Array<{ name: string; r1cs: string }>;
}

/**
 * Generates _0000.zkey for each circuit and writes ceremony/state.json.
 * Called by the deployer after circuits are compiled.
 */
export async function ceremonyInit(opts: InitOptions): Promise<void> {
  const { projectDir, buildDir, ptauPath, circuits } = opts;
  await mkdir(path.join(projectDir, 'ceremony'), { recursive: true });

  const r1csPaths: Record<string, string> = {};

  for (const { name, r1cs } of circuits) {
    const zkey0 = path.join(projectDir, 'ceremony', `${name}_0000.zkey`);
    await execa(SNARKJS_BIN, ['groth16', 'setup', r1cs, ptauPath, zkey0]);
    r1csPaths[name] = r1cs;
  }

  const state: CeremonyState = {
    circuits: circuits.map((c) => c.name),
    r1csPaths,
    ptauPath,
    contributions: [],
    finalized: false,
  };

  await writeState(projectDir, state);
}

// ─── Contribute ───────────────────────────────────────────────────────────────

export interface ContributeOptions {
  projectDir: string;
  contributorName: string;
  /** Optional personal entropy — combined with CSPRNG via SHA-256 */
  personalEntropy?: string;
}

/**
 * Adds one contribution round across all circuits in the ceremony.
 * Returns the contribution hashes so the contributor can record them.
 */
export async function ceremonyContribute(
  opts: ContributeOptions
): Promise<Record<string, string>> {
  const { projectDir, contributorName, personalEntropy } = opts;
  const state = await readState(projectDir);

  if (state.finalized) throw new Error('Ceremony already finalized');

  const nextIndex = state.contributions.length + 1;
  const paddedIndex = String(nextIndex).padStart(4, '0');
  const prevIndex = String(nextIndex - 1).padStart(4, '0');

  // Combine CSPRNG with personal entropy via SHA-256 so neither alone is sufficient
  const csprng = randomBytes(32).toString('hex');
  const combined = personalEntropy
    ? createHash('sha256').update(csprng + personalEntropy).digest('hex')
    : csprng;

  const hashes: Record<string, string> = {};

  for (const circuitName of state.circuits) {
    const prevZkey = path.join(projectDir, 'ceremony', `${circuitName}_${prevIndex}.zkey`);
    const nextZkey = path.join(projectDir, 'ceremony', `${circuitName}_${paddedIndex}.zkey`);

    const result = await execa(SNARKJS_BIN, [
      'zkey', 'contribute',
      prevZkey, nextZkey,
      '--name', contributorName,
      '-e', combined,
    ]);

    // snarkjs prints the contribution hash to stdout — extract it
    const hashMatch = result.stdout.match(/Contribution Hash:\s*\n\s*([0-9a-f\s]+)/i);
    hashes[circuitName] = hashMatch
      ? hashMatch[1].replace(/\s+/g, '').toLowerCase()
      : 'see snarkjs output';
  }

  // Record the contribution in state (use Transfer hash as representative)
  const representative = hashes[state.circuits[0]] ?? Object.values(hashes)[0];
  state.contributions.push({
    index: nextIndex,
    name: contributorName,
    contributionHash: representative,
    timestamp: new Date().toISOString(),
  });

  await writeState(projectDir, state);
  return hashes;
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  verifiers: Record<string, string>;   // circuitName → .sol path
  vkeys: Record<string, string>;       // circuitName → vkey.json path
  beaconHash: string;
}

/**
 * Applies a CSPRNG beacon, exports verifiers, and verifies the transcript.
 * Copies the resulting .sol files into contracts/src/.
 */
export async function ceremonyFinalize(
  projectDir: string,
  contractsSrcDir: string
): Promise<FinalizeResult> {
  const state = await readState(projectDir);

  if (state.finalized) throw new Error('Ceremony already finalized');
  if (state.contributions.length === 0) {
    throw new Error('No contributions yet — add at least one contributor before finalizing');
  }

  const beaconHash = randomBytes(32).toString('hex');
  const lastIndex = String(state.contributions.length).padStart(4, '0');

  const verifiers: Record<string, string> = {};
  const vkeys: Record<string, string> = {};

  for (const circuitName of state.circuits) {
    const lastZkey   = path.join(projectDir, 'ceremony', `${circuitName}_${lastIndex}.zkey`);
    const finalZkey  = path.join(projectDir, 'ceremony', `${circuitName}_final.zkey`);
    const vkeyPath   = path.join(projectDir, 'ceremony', `${circuitName}_vkey.json`);
    const verifierPath = path.join(projectDir, 'ceremony', `Groth16Verifier_${circuitName}.sol`);

    // Apply beacon
    await execa(SNARKJS_BIN, ['zkey', 'beacon', lastZkey, finalZkey, beaconHash, '10']);

    // Export verification key + Solidity verifier
    await execa(SNARKJS_BIN, ['zkey', 'export', 'verificationkey', finalZkey, vkeyPath]);
    await execa(SNARKJS_BIN, ['zkey', 'export', 'solidityverifier', finalZkey, verifierPath]);

    // Verify the full transcript
    await execa(SNARKJS_BIN, ['zkey', 'verify', state.r1csPaths[circuitName], state.ptauPath, finalZkey]);

    // Copy verifier into contracts/src so it's ready to deploy
    await copyFile(verifierPath, path.join(contractsSrcDir, `Groth16Verifier_${circuitName}.sol`));

    verifiers[circuitName] = verifierPath;
    vkeys[circuitName] = vkeyPath;
  }

  state.finalized = true;
  await writeState(projectDir, state);

  return { verifiers, vkeys, beaconHash };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Re-verifies the ceremony transcript and prints the contribution chain.
 */
export async function ceremonyVerify(projectDir: string): Promise<void> {
  const state = await readState(projectDir);

  for (const circuitName of state.circuits) {
    const finalZkey = path.join(projectDir, 'ceremony', `${circuitName}_final.zkey`);
    await execa(SNARKJS_BIN, [
      'zkey', 'verify',
      state.r1csPaths[circuitName],
      state.ptauPath,
      finalZkey,
    ], { stdout: 'inherit', stderr: 'inherit' });
  }
}
