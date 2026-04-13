import { copyFile, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ProjectConfig } from './config.js';
import {
  generateTransferCircuit,
  generateAddDataCircuit,
  generateContract,
  generateBabyJubjub,
  generateDeployScript,
  generateBindings,
  generateOutputPackageJson,
  generateFoundryToml,
} from './generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

export interface OutputPaths {
  root: string;
  circuitsDir: string;
  contractsDir: string;
  bindingsDir: string;
  buildDir: string;
  transferCircuit: string;
  addDataCircuit: string;
}

export async function writeProjectFiles(cfg: ProjectConfig): Promise<OutputPaths> {
  const root = cfg.outputDir;
  const circuitsDir  = path.join(root, 'circuits');
  const contractsDir = path.join(root, 'contracts', 'src');
  const scriptsDir   = path.join(root, 'contracts', 'script');
  const bindingsDir  = path.join(root, 'bindings');
  const buildDir     = path.join(root, 'build');

  await mkdir(circuitsDir,  { recursive: true });
  await mkdir(contractsDir, { recursive: true });
  await mkdir(scriptsDir,   { recursive: true });
  await mkdir(bindingsDir,  { recursive: true });
  await mkdir(buildDir,     { recursive: true });

  // ── Circuits ──────────────────────────────────────────────────────────────
  const transferCircuit = path.join(circuitsDir, 'EcdhPoseidonTransfer.circom');
  const addDataCircuit  = path.join(circuitsDir, 'AddNewDataEncrypt.circom');

  await writeFile(transferCircuit, generateTransferCircuit(cfg));
  await writeFile(addDataCircuit,  generateAddDataCircuit(cfg));

  // Copy bundled circuit dependencies into the circuits dir
  for (const file of ['poseidon-cipher.circom', 'poseidon-constants-old.circom', 'ecdh.circom']) {
    await copyFile(path.join(ASSETS_DIR, file), path.join(circuitsDir, file));
  }

  // ── Contracts ─────────────────────────────────────────────────────────────
  await writeFile(path.join(contractsDir, 'EncryptedERC721.sol'),  generateContract(cfg));
  await writeFile(path.join(contractsDir, 'BabyJubjub.sol'),       generateBabyJubjub());
  await writeFile(path.join(scriptsDir,   'Deploy.s.sol'),         generateDeployScript(cfg));
  await writeFile(path.join(root, 'contracts', 'foundry.toml'),    generateFoundryToml(cfg));

  // ── Bindings ──────────────────────────────────────────────────────────────
  await writeFile(path.join(bindingsDir, 'index.ts'),              generateBindings(cfg));
  await writeFile(path.join(bindingsDir, 'package.json'),          generateOutputPackageJson(cfg));

  return {
    root,
    circuitsDir,
    contractsDir,
    bindingsDir,
    buildDir,
    transferCircuit,
    addDataCircuit,
  };
}
