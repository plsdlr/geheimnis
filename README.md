# Geheimnis

```
░█▀▀░█▀▀░█░█░█▀▀░▀█▀░█▄█░█▀█░▀█▀░█▀▀
░█░█░█▀▀░█▀█░█▀▀░░█░░█░█░█░█░░█░░▀▀█
░▀▀▀░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀░▀░▀░▀░▀▀▀░▀▀▀
```

> *Geheimnis* (German) — secret, mystery.

A CLI template engine that generates a complete **ZK-encrypted ERC-721 stack** from a single parameter: how many plaintext fields you want to store per token.

Run `geheimnis` once and get production-ready circom circuits, Groth16 verifier contracts, a Solidity ERC-721, and TypeScript bindings — all wired together and compiled.

---
## Acknowledgment

This template engine was developed as part of cipher, which was supported by [JUST Open Source](https://www.justopensource.io/). The circom circuits rely on the [ZK-Kit](https://github.com/zk-kit) developed by the [Privacy Stewards of Ethereum (PSE)](https://pse.dev/).


## What it generates

```
my-project/
├── circuits/
│   ├── EcdhPoseidonTransfer.circom   # transfer proof circuit
│   └── AddNewDataEncrypt.circom      # mint / reCipher proof circuit
├── contracts/src/
│   ├── EncryptedERC721.sol           # your ERC-721 contract
│   ├── Groth16Verifier_Transfer.sol  # auto-generated on-chain verifier
│   ├── Groth16Verifier_AddData.sol   # auto-generated on-chain verifier
│   └── BabyJubjub.sol                # cosmetic curve point validation
├── bindings/
│   └── index.ts                      # encrypt / decrypt / proof builders
└── build/
    ├── *.zkey                        # proving keys (needed client-side)
    └── *_vkey.json                   # verification keys
```

Everything is parameterized by **N** — the number of plaintext field elements per token. All circuit sizes, public signal counts, and contract storage layouts derive automatically from N.

---

## How it works

Each token stores **N** plaintext field elements encrypted on-chain as **C = ceil(N/3)×3 + 1** ciphertext `uint256` values. Encryption uses Poseidon symmetric cipher keyed via ECDH on the Baby Jubjub curve.

Standard `transferFrom` is disabled. The only way to transfer a token is through `verifiedTransferFrom`, which requires a Groth16 proof that the sender:
1. Knows their private key
2. Correctly decrypted the old ciphertext
3. Re-encrypted the **same plaintext** for the new recipient

Nobody ever sees the plaintext on-chain. The proof system enforces the re-encryption honestly.

After receiving a token, the new owner can call `reCipher` to re-encrypt under a purely self-derived key, breaking any dependency on the sender's keypair.

---

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [circom](https://docs.circom.io/getting-started/installation/) (in PATH)
- [pnpm](https://pnpm.io/) (or npm / yarn)

```bash
# install circom
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
cargo install circom
```

---

## Install

```bash
git clone https://github.com/your-org/geheimnis.git
cd geheimnis
pnpm install
```

Run from the project directory via pnpm:

```bash
pnpm geheimnis
pnpm geheimnis ceremony init ./my-project
pnpm geheimnis ceremony contribute ./my-project
```

Optionally, link it globally so you can run `geheimnis` from any directory without `pnpm`:

```bash
pnpm build
pnpm link --global

geheimnis
geheimnis ceremony init ./my-project
```

---

## Usage

### Generate a project

```bash
geheimnis
```

The CLI will ask:

| Prompt               | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| **N**                | Plaintext field elements per token. Determines circuit size and storage layout. |
| **Collection name**  | Used for the contract name and output directory.                                |
| **Symbol**           | ERC-721 token symbol.                                                           |
| **Include minting?** | Whether to add public mint logic (price, max supply, trusted minter).           |
| **Max supply**       | *(if minting enabled)* Maximum tokens that can be minted.                       |
| **Mint price**       | *(if minting enabled)* Price in ETH per mint.                                   |
| **Output directory** | Where to write the generated project.                                           |

Geheimnis then:
1. Writes all source files
2. Compiles both circuits with circom
3. Downloads the required Powers-of-Tau file (cached in `~/.geheimnis/ptau/`)
4. Runs the Groth16 trusted setup
5. Exports verifier contracts and verification keys

### After generation

```bash
cd my-project/contracts
forge install
forge build
forge script script/Deploy.s.sol --broadcast
```

Copy `build/*.zkey` and `circuits/*.wasm` to your front-end for client-side proving.

---

## Choosing N

| N     | ptau  | Proving                               | Notes                          |
| ----- | ----- | ------------------------------------- | ------------------------------ |
| 1–15  | 2^15  | Browser-safe (~5–10s in a web worker) | Recommended for most use cases |
| 16–30 | 2^16  | Server-side recommended               | Still reasonable calldata      |
| > 30  | 2^17+ | Slow, large wasm                      | Not recommended                |

The soft limit is **N = 30**. At N = 30 the total calldata per transaction is roughly 2.5 KB (256 bytes fixed proof + ~2.2 KB public signals), well within RPC limits.

---

## Minting modes

### With public minting

```solidity
// Anyone can mint by paying mintPrice and supplying a valid proof
contract.mint(proof, pubSignals, to)

// A trusted minter address can mint for free
contract.mintFrom(proof, pubSignals, to)
```

The trusted minter is set at deployment and can be updated by the owner via `setMinter()`. Useful for a back-end service that generates proofs on behalf of users.

### Owner-only (no public minting)

```solidity
// Only the contract owner can mint
contract.adminMint(proof, pubSignals, to)
```

No price, no supply cap, no trusted minter. Simpler deploy for curated collections.

---

## Multi-party trusted setup (ceremony)

The default flow uses a single-party trusted setup — reasonable when you already trust the deployer as the contract owner. For higher trust requirements, Geheimnis includes a multi-party ceremony workflow.

The ceremony is secure as long as **at least one contributor** destroyed their toxic waste after contributing.

### How to start one

When running `geheimnis`, answer **yes** to the prompt:

```
Use multi-party trusted setup? (skips single-party setup — run ceremony init after)
```

This generates and compiles the circuits but skips step 4. You then run the ceremony commands to produce the final proving keys.

### Full flow

```bash
# 1. Deployer: generate project with ceremony mode enabled
geheimnis
# → answer yes to multi-party prompt

# 2. Deployer: initialise the ceremony (creates _0000.zkey files)
geheimnis ceremony init ./my-project
# → enter path to the .ptau file downloaded in step 3 of generation

# 3. Share the ceremony/ directory with each contributor (zip, file share, etc.)
#    Each contributor runs:
geheimnis ceremony contribute ./my-project
# → enter your name and optional personal entropy
# → prints a contribution hash — record it and share with the group

# 4. Deployer: finalise once all contributors are done
geheimnis ceremony finalize ./my-project
# → applies a random beacon, exports verifier contracts, verifies the transcript

# 5. Anyone can audit the transcript at any time
geheimnis ceremony verify ./my-project
```

Each contribution combines the system CSPRNG with optional personal entropy via SHA-256 — neither source alone is sufficient.

```
Deployer           Contributors           Deployer
    │                    │                    │
geheimnis           contribute ×N        ceremony finalize
ceremony init            │                    │
    │           _0001 → _0002 → …       beacon → final.zkey
 _0000.zkey                              → export verifiers
                                         → snarkjs verify
```

---

## TypeScript bindings

The generated `bindings/index.ts` exposes helpers for the front-end:

```ts
import {
  derivePublicKey,
  computeSharedKey,
  poseidonEncrypt,
  poseidonDecrypt,
  buildMintInput,
  buildTransferInput,
} from './bindings/index.js';

// Derive a Baby Jubjub public key from a private key
const pubKey = derivePublicKey(privateKey);

// Build inputs for a mint proof
const { input, ciphertext } = buildMintInput({ privateKey, message: [1n, 2n, 3n] });

// Build inputs for a transfer proof
const transferInput = buildTransferInput({
  senderPrivateKey,
  recipientPublicKey,
  oldCiphertext,
  oldNonce,
  message,
});
```

Pass `input` to snarkjs `fullProve()` with the appropriate `.wasm` and `.zkey` files.

---

## Architecture

```
geheimnis (CLI)
├── src/config.ts      — parameter derivation (N → C, S_t, S_a, ptauPower)
├── src/generator.ts   — circom / Solidity / TS source code generation
├── src/builder.ts     — circom compilation, ptau download, Groth16 setup
├── src/writer.ts      — file I/O, directory layout
├── src/ceremony.ts    — multi-party trusted setup (init / contribute / finalize / verify)
└── src/cli.ts         — interactive prompts and orchestration

assets/
├── poseidon-cipher.circom       — Poseidon sponge encryption
├── poseidon-constants-old.circom
└── ecdh.circom                  — Baby Jubjub ECDH
```

The circuits include `circomlib` primitives (`babyjub.circom`, `bitify.circom`, etc.) which are bundled as a dependency.

---

## EIP

This project implements [EIP-XXXX: ZK-Encrypted ERC-721 with On-Chain Encrypted Metadata](./EIP-XXXX.md).

---

## License

All original code © GNU Affero General Public License. Third-party libraries and dependencies retain their original licenses.
