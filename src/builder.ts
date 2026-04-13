import { execa } from 'execa';
import { createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { randomBytes } from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ProjectConfig } from './config.js';
import { ptauUrl } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to snarkjs CLI bundled with Geheimnis
const SNARKJS_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin', 'snarkjs');

// Default ptau cache directory
const PTAU_CACHE = path.resolve(
  process.env.HOME ?? '.',
  '.geheimnis',
  'ptau'
);

export async function checkCircom(): Promise<void> {
  try {
    await execa('circom', ['--version']);
  } catch {
    throw new Error(
      'circom not found. Install it from https://docs.circom.io/getting-started/installation/'
    );
  }
}

export async function compileCirucit(
  circuitPath: string,
  outputDir: string,
  includesDir: string
): Promise<void> {
  const circomlibCircuits = path.resolve(__dirname, '..', 'node_modules', 'circomlib', 'circuits');
  await execa('circom', [
    circuitPath,
    '--r1cs',
    '--wasm',
    '--sym',
    '--output', outputDir,
    '-l', circomlibCircuits,
    '-l', includesDir,
  ]);
}

export async function getPtau(power: number): Promise<string> {
  await mkdir(PTAU_CACHE, { recursive: true });
  const filename = `powersOfTau28_hez_final_${String(power).padStart(2, '0')}.ptau`;
  const dest = path.join(PTAU_CACHE, filename);

  try {
    await stat(dest);
    return dest; // already cached
  } catch {
    // not cached — download it
  }

  const url = ptauUrl(power);
  await download(url, dest);
  return dest;
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = createWriteStream(dest);

    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        download(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: HTTP ${res.statusCode} — ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

export interface SetupPaths {
  zkey0: string;
  zkeyFinal: string;
  vkey: string;
  solidityVerifier: string;
}

export async function runSetup(
  r1csPath: string,
  ptauPath: string,
  buildDir: string,
  name: string
): Promise<SetupPaths> {
  await mkdir(buildDir, { recursive: true });

  const zkey0 = path.join(buildDir, `${name}_0000.zkey`);
  const zkeyFinal = path.join(buildDir, `${name}_final.zkey`);
  const vkey = path.join(buildDir, `${name}_vkey.json`);
  const solidityVerifier = path.join(buildDir, `Groth16Verifier_${name}.sol`);

  // Phase 2 init
  await execa(SNARKJS_BIN, ['groth16', 'setup', r1csPath, ptauPath, zkey0]);

  // Random beacon — 32 bytes from the OS CSPRNG (crypto.randomBytes delegates to
  // getrandom(2) on Linux / BCryptGenRandom on Windows). Unique per run.
  const beaconHash = randomBytes(32).toString('hex');
  await execa(SNARKJS_BIN, ['zkey', 'beacon', zkey0, zkeyFinal, beaconHash, '10']);

  // Export verification key
  await execa(SNARKJS_BIN, ['zkey', 'export', 'verificationkey', zkeyFinal, vkey]);

  // Export Solidity verifier
  await execa(SNARKJS_BIN, ['zkey', 'export', 'solidityverifier', zkeyFinal, solidityVerifier]);

  return { zkey0, zkeyFinal, vkey, solidityVerifier };
}

export function r1csPath(buildDir: string, name: string): string {
  // circom outputs <circuitname>.r1cs in the directory we specified
  return path.join(buildDir, `${path.basename(name, '.circom')}.r1cs`);
}
