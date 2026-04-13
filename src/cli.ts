#!/usr/bin/env node
import { input, number, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { computeParams } from './config.js';
import { checkCircom, compileCirucit, getPtau, runSetup, r1csPath } from './builder.js';
import { writeProjectFiles } from './writer.js';
import {
  ceremonyInit,
  ceremonyContribute,
  ceremonyFinalize,
  ceremonyVerify,
} from './ceremony.js';
import type { ProjectConfig } from './config.js';

const log = {
  step: (n: number, total: number, msg: string) =>
    console.log(chalk.cyan(`\n[${n}/${total}]`) + ' ' + msg),
  success: (msg: string) => console.log(chalk.green('  ✓ ') + msg),
  warn: (msg: string) => console.log(chalk.yellow('  ⚠ ') + msg),
  info: (msg: string) => console.log(chalk.gray('    ') + msg),
};

async function main() {
  console.log(chalk.bold('\nGeheimnis') + chalk.gray(' — ZK-encrypted NFT generator\n'));

  // ── Step 0: Check circom is installed ──────────────────────────────────────
  const spinner = ora('Checking for circom...').start();
  try {
    await checkCircom();
    spinner.succeed('circom found');
  } catch (err: any) {
    spinner.fail(err.message);
    process.exit(1);
  }

  // ── Gather config ──────────────────────────────────────────────────────────
  console.log(chalk.gray(
    '  N=1–15  browser-safe proving  (~5–10s in a web worker)\n' +
    '  N=16–30 server-side proving   (still fits ptau_15, reasonable calldata)\n' +
    '  N>30    not recommended       (larger ptau, slow proving, large wasm)\n'
  ));

  const N = await number({
    message: 'How many plaintext field elements (N) per token?',
    default: 3,
    validate: (v) => {
      if (!v || v < 1) return 'Must be at least 1';
      if (v > 30) return 'N > 30 is not recommended — use server-side proving and a larger ptau file';
      return true;
    },
  }) as number;

  const params = computeParams(N);

  const provingNote =
    N <= 15 ? chalk.green('browser-safe') :
    N <= 30 ? chalk.yellow('server-side proving recommended') :
              chalk.red('large ptau needed, slow proving');

  console.log(chalk.gray(
    `\n  N=${N}  C=${params.C}  S_t=${params.S_t}  S_a=${params.S_a}  ptau=2^${params.ptauPower}  ${provingNote}\n`
  ));

  const collectionName = await input({
    message: 'Collection name?',
    default: 'MyEncryptedNFT',
  });

  const symbol = await input({
    message: 'Symbol?',
    default: 'MENFT',
  });

  const hasMintLogic = await confirm({
    message: 'Include public minting? (price, max supply, trusted minter)',
    default: true,
  });

  let maxSupply: number | undefined;
  let mintPrice: string | undefined;

  if (hasMintLogic) {
    maxSupply = await number({
      message: 'Max supply?',
      default: 100,
      validate: (v) => (!v || v < 1 ? 'Must be at least 1' : true),
    }) as number;

    mintPrice = await input({
      message: 'Mint price (ETH)?',
      default: '0.05',
      validate: (v) => {
        const n = parseFloat(v);
        return isNaN(n) || n < 0 ? 'Enter a valid ETH amount (e.g. 0.05)' : true;
      },
    });
  }

  const outputDir = await input({
    message: 'Output directory?',
    default: `./${collectionName.toLowerCase().replace(/\s+/g, '-')}-geheimnis`,
  });

  const cfg: ProjectConfig = {
    ...params,
    name: collectionName,
    symbol,
    hasMintLogic,
    maxSupply,
    mintPrice,
    outputDir: path.resolve(outputDir),
  };

  console.log('');

  const TOTAL_STEPS = 5;

  // ── Step 1: Write files ────────────────────────────────────────────────────
  log.step(1, TOTAL_STEPS, 'Generating source files...');
  const sp1 = ora({ indent: 4 }).start('Writing circuits, contracts, bindings');
  let paths;
  try {
    paths = await writeProjectFiles(cfg);
    sp1.succeed('Files written');
  } catch (err: any) {
    sp1.fail(err.message);
    process.exit(1);
  }

  log.success(`${paths.transferCircuit}`);
  log.success(`${paths.addDataCircuit}`);
  log.success(`${paths.contractsDir}/EncryptedERC721.sol`);
  log.success(`${paths.bindingsDir}/index.ts`);

  // ── Step 2: Compile circuits ───────────────────────────────────────────────
  log.step(2, TOTAL_STEPS, 'Compiling circom circuits (this takes a minute)...');

  for (const [label, circuitPath] of [
    ['Transfer', paths.transferCircuit],
    ['AddData',  paths.addDataCircuit],
  ] as const) {
    const sp = ora({ indent: 4 }).start(`Compiling ${label} circuit`);
    try {
      await compileCirucit(circuitPath, paths.buildDir, paths.circuitsDir);
      sp.succeed(`${label} circuit compiled`);
    } catch (err: any) {
      sp.fail(`${label} compilation failed`);
      console.error(chalk.red(err.stderr ?? err.message));
      process.exit(1);
    }
  }

  // ── Step 3: Download ptau ──────────────────────────────────────────────────
  log.step(3, TOTAL_STEPS, `Fetching powers-of-tau (2^${params.ptauPower})...`);
  const sp3 = ora({ indent: 4 }).start('Checking cache (~/.geheimnis/ptau/)');
  let ptauPath: string;
  try {
    ptauPath = await getPtau(params.ptauPower);
    sp3.succeed(`ptau ready: ${ptauPath}`);
  } catch (err: any) {
    sp3.fail(err.message);
    process.exit(1);
  }

  // ── Step 4: Groth16 trusted setup ─────────────────────────────────────────
  log.step(4, TOTAL_STEPS, 'Running Groth16 trusted setup (single-party)...');
  log.warn('Single-party setup — trust assumption equivalent to contract ownership.');

  for (const [label, circuitName] of [
    ['Transfer', 'EcdhPoseidonTransfer'],
    ['AddData',  'AddNewDataEncrypt'],
  ] as const) {
    const r1cs = r1csPath(paths.buildDir, circuitName);
    const sp = ora({ indent: 4 }).start(`${label}: groth16 setup`);
    try {
      const setupPaths = await runSetup(r1cs, ptauPath, paths.buildDir, label);
      sp.succeed(`${label} setup complete`);
      log.info(`zkey:     ${setupPaths.zkeyFinal}`);
      log.info(`vkey:     ${setupPaths.vkey}`);
      log.info(`verifier: ${setupPaths.solidityVerifier}`);

      // Move the generated verifier into the contracts/src dir
      const { copyFile } = await import('fs/promises');
      await copyFile(
        setupPaths.solidityVerifier,
        `${paths.contractsDir}/Groth16Verifier_${label}.sol`
      );
    } catch (err: any) {
      sp.fail(`${label} setup failed`);
      console.error(chalk.red(err.stderr ?? err.message));
      process.exit(1);
    }
  }

  // ── Step 5: Summary ────────────────────────────────────────────────────────
  log.step(5, TOTAL_STEPS, 'Done!');
  console.log(`
${chalk.bold('Output:')} ${chalk.cyan(paths.root)}

  ${chalk.gray('circuits/')}
    EcdhPoseidonTransfer.circom   — transfer proof circuit
    AddNewDataEncrypt.circom      — mint / reCipher proof circuit

  ${chalk.gray('contracts/src/')}
    EncryptedERC721.sol           — your ERC-721 contract
    Groth16Verifier_Transfer.sol  — auto-generated on-chain verifier
    Groth16Verifier_AddData.sol   — auto-generated on-chain verifier
    BabyJubjub.sol                — curve point validation

  ${chalk.gray('bindings/')}
    index.ts                      — encrypt / decrypt / proof builders

  ${chalk.gray('build/')}
    *.zkey                        — proving keys (needed client-side)
    *_vkey.json                   — verification keys

${chalk.yellow('Next steps:')}
  1. cd ${paths.root}/contracts && forge install && forge build
  2. Copy build/*.zkey + circuits/*.wasm to your front-end
  3. Deploy: forge script script/Deploy.s.sol --broadcast
  `);
}

// ─── Ceremony subcommands ─────────────────────────────────────────────────────

async function ceremonyCli(): Promise<void> {
  const sub = process.argv[3];

  if (!sub || sub === 'help') {
    console.log(`
${chalk.bold('geheimnis ceremony')} — multi-party trusted setup

  ${chalk.cyan('init <project-dir>')}
    Generate _0000.zkey files and write ceremony/state.json.
    Run once after circuits are compiled.

  ${chalk.cyan('contribute <project-dir>')}
    Add your randomness to the ceremony.
    Run once per contributor; outputs the next numbered zkey.

  ${chalk.cyan('finalize <project-dir>')}
    Apply a random beacon, export verifiers, and verify the transcript.
    Run after all contributors have participated.

  ${chalk.cyan('verify <project-dir>')}
    Re-verify the ceremony transcript and print the contribution chain.
`);
    return;
  }

  const projectDir = path.resolve(process.argv[4] ?? '.');

  if (sub === 'init') {
    // Requires a compiled project directory — read state from build/
    const buildDir = path.join(projectDir, 'build');
    const ptauFile = await input({
      message: 'Path to .ptau file?',
      default: `${process.env.HOME ?? '.'}/.geheimnis/ptau/powersOfTau28_hez_final_16.ptau`,
    });

    const circuitNames = ['Transfer', 'AddData'];
    const circuits = circuitNames.map((name) => ({
      name,
      r1cs: path.join(buildDir, `${name === 'Transfer' ? 'EcdhPoseidonTransfer' : 'AddNewDataEncrypt'}.r1cs`),
    }));

    const sp = ora('Initialising ceremony...').start();
    try {
      await ceremonyInit({ projectDir, buildDir, ptauPath: ptauFile, circuits });
      sp.succeed('Ceremony initialised — ceremony/state.json written');
      console.log(chalk.gray('\n  Share ceremony/ with your first contributor.'));
    } catch (err: any) {
      sp.fail(err.message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'contribute') {
    const name = await input({
      message: 'Your name (recorded in the transcript)?',
    });
    const entropy = await input({
      message: 'Optional personal entropy (leave blank to use CSPRNG only)?',
    });

    const sp = ora(`Adding contribution for "${name}"...`).start();
    try {
      const hashes = await ceremonyContribute({
        projectDir,
        contributorName: name,
        personalEntropy: entropy || undefined,
      });
      sp.succeed('Contribution recorded');
      console.log(chalk.bold('\nContribution hashes (verify with other participants):'));
      for (const [circuit, hash] of Object.entries(hashes)) {
        console.log(`  ${chalk.cyan(circuit)}: ${hash}`);
      }
    } catch (err: any) {
      sp.fail(err.message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'finalize') {
    const contractsSrcDir = path.join(projectDir, 'contracts', 'src');
    const sp = ora('Finalising ceremony...').start();
    try {
      const result = await ceremonyFinalize(projectDir, contractsSrcDir);
      sp.succeed('Ceremony finalised');
      console.log(chalk.bold('\nBeacon hash:'), result.beaconHash);
      console.log(chalk.bold('Verifiers:'));
      for (const [circuit, p] of Object.entries(result.verifiers)) {
        console.log(`  ${chalk.cyan(circuit)}: ${p}`);
      }
      console.log(chalk.bold('Verification keys:'));
      for (const [circuit, p] of Object.entries(result.vkeys)) {
        console.log(`  ${chalk.cyan(circuit)}: ${p}`);
      }
    } catch (err: any) {
      sp.fail(err.message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'verify') {
    console.log(chalk.bold(`Verifying ceremony transcript in ${projectDir}...\n`));
    try {
      await ceremonyVerify(projectDir);
      console.log(chalk.green('\nTranscript verified.'));
    } catch (err: any) {
      console.error(chalk.red('\nVerification failed:'), err.message);
      process.exit(1);
    }
    return;
  }

  console.error(chalk.red(`Unknown ceremony subcommand: ${sub}`));
  console.error('Run `geheimnis ceremony help` for usage.');
  process.exit(1);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const cmd = process.argv[2];

if (cmd === 'ceremony') {
  ceremonyCli().catch((err) => {
    console.error(chalk.red('\nFatal error:'), err.message ?? err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(chalk.red('\nFatal error:'), err.message ?? err);
    process.exit(1);
  });
}
