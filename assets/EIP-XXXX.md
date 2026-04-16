---
eip: XXXX
title: ZK-Encrypted ERC-721 with On-Chain Encrypted Metadata
description: An ERC-721 extension that stores encrypted metadata on-chain and enforces zero-knowledge re-encryption on every transfer using ECDH key exchange over the Baby Jubjub curve.
author: plsdlr
status: Draft
type: Standards Track
category: ERC
created: 2025-02-17
requires: 721
---

## Abstract

This standard defines an extension to [ERC-721](./eip-721.md) that attaches **encrypted metadata** to each token and enforces **zero-knowledge proof-verified re-encryption** on every transfer. Token metadata is stored on-chain as `C` `uint256` ciphertext fields (where `C = ceil(N/3)*3 + 1` and `N` is the number of plaintext field elements), encrypted using Poseidon-based symmetric encryption keyed via ECDH on the Baby Jubjub curve. The parameter `N` is chosen at deployment time and determines the circuit, verifier, and storage layout. Standard `transferFrom` and `safeTransferFrom` are disabled; all transfers MUST go through `verifiedTransferFrom`, which requires a Groth16 proof demonstrating that the sender correctly decrypted the old ciphertext and re-encrypted the plaintext for the recipient. An additional `reCipher` operation allows the owner to re-encrypt data under their own keypair after receiving a token.

## Motivation

Existing NFT standards store metadata either off-chain (IPFS/HTTP URIs) or as plaintext on-chain. Neither approach supports **confidential, owner-exclusive metadata** where:

1. Only the current owner can read the token's underlying data.
2. Transfers provably re-encrypt the data for the new owner without revealing plaintext on-chain.
3. The integrity of the encrypted data is verifiable without trusting any party.

Use cases include:

- **Generative art with hidden parameters**: Artistic parameters (e.g., Turmite rulesets, positions, colors) are encrypted so only the owner can render the artwork, preserving scarcity of the visual output.
- **On-chain encrypted credentials or game state**: Any data that should travel with a token but remain private to its holder.
- **Trustless encrypted marketplaces**: Tokens can be listed and sold without revealing their contents until after purchase.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

### Parameters

All compliant contracts are parameterized by a single constant **`N`** — the number of plaintext field elements (BN254 scalar field values) stored per token. All other dimensions derive from `N`:

| Symbol | Derivation              | Description                                                                 |
|--------|-------------------------|-----------------------------------------------------------------------------|
| `N`    | Deployment-time choice  | Number of plaintext field elements per token                                |
| `P`    | `N` rounded up to next multiple of 3 | Padded plaintext length (Poseidon operates on blocks of 3)    |
| `C`    | `P + 1`                | Number of ciphertext `uint256` fields stored per token (includes auth tag)  |
| `S_t`  | `2C + 5`               | Public signals count for the **ECDH transfer** proof                        |
| `S_a`  | `2C + 6`               | Public signals count for the **AddData** proof (includes mode flag)         |

For example:

| `N` | `P` | `C` | `S_t` | `S_a` | Use case example                  |
|-----|-----|-----|-------|-------|-----------------------------------|
| 1   | 3   | 4   | 13    | 14    | Single encrypted value            |
| 3   | 3   | 4   | 13    | 14    | Three-slot generative art params  |
| 6   | 6   | 7   | 19    | 20    | Six-slot extended metadata        |
| 9   | 9   | 10  | 25    | 26    | Nine-slot rich token data         |

### Overview

A compliant contract MUST:

1. Implement [ERC-721](./eip-721.md).
2. Store a per-token **encrypted note** consisting of `C` `uint256` ciphertext fields.
3. Maintain a **public key registry** mapping addresses to Baby Jubjub public keys `(x, y)`.
4. Disable `transferFrom` and `safeTransferFrom` by reverting unconditionally.
5. Expose `verifiedTransferFrom` which accepts a Groth16 proof and re-encrypts data for the recipient.
6. Expose `reCipher` for an owner to re-encrypt after receiving a token via ECDH-encrypted transfer.
7. Deploy two Groth16 verifier contracts compiled for the chosen `N`: one for **ECDH transfer proofs** and one for **add/update data proofs**.
8. Expose `N` as a public constant or immutable so consumers can determine the ciphertext layout.

### Data Structures

#### Encrypted Note

For a deployment with parameter `N`, the encrypted note MUST store exactly `C = ceil(N/3)*3 + 1` ciphertext fields. Implementations MAY use any storage layout that exposes `C` `uint256` values per token. Two RECOMMENDED approaches:

**Fixed struct** (when `N` is known at authoring time):

```solidity
// Example for N=3, C=4
struct note {
    uint256 field1;
    uint256 field2;
    uint256 field3;
    uint256 field4;
}
mapping(uint256 => note) public tokenIdToNote;
```

**Dynamic mapping** (generic for any `N`):

```solidity
uint256 public immutable N;
uint256 public immutable C; // = ceil(N/3)*3 + 1

// tokenId => field index => ciphertext value
mapping(uint256 => mapping(uint256 => uint256)) public tokenCiphertext;
```

#### Per-Token Extra Data

Each token packs a **95-bit timestamp** and a **1-bit encryption flag** into 96 bits of extra data (using ERC-721's `extraData` slot):

| Bit(s)  | Field     | Description                                                         |
|---------|-----------|---------------------------------------------------------------------|
| 0–94    | timestamp | Unix timestamp of the last encryption event                         |
| 95      | flag      | `1` = encrypted with owner's own keypair; `0` = encrypted via ECDH  |

The flag indicates whether the token was freshly encrypted by the owner (`flag=1`, after mint or reCipher) or encrypted for the owner by the sender during transfer (`flag=0`). A token with `flag=0` is eligible for `reCipher`.

### Cryptographic Primitives

All operations occur over the **Baby Jubjub** elliptic curve (as used in circomlib) over the BN254 scalar field.

| Primitive              | Description                                                                                         |
|------------------------|-----------------------------------------------------------------------------------------------------|
| Baby Jubjub Key Pair   | Private key scalar `sk`; public key `PK = sk * G` where `G` is the Baby Jubjub base point.         |
| ECDH Shared Secret     | Given private key `sk_A` and public key `PK_B`, the shared key is `S = sk_A * PK_B`.               |
| Poseidon Encryption    | Sponge-based symmetric cipher using the Poseidon permutation. Encrypts an `N`-element message into `C` ciphertext elements (`P` ciphertext blocks + 1 authentication tag) using a 2-element key and a 128-bit nonce. |
| Poseidon Decryption    | Inverse of Poseidon encryption. Recovers the `N`-element plaintext from `C` ciphertext elements using the same key and nonce. |
| Groth16 Proof          | zkSNARK proof system. Proofs are verified on-chain via auto-generated Solidity verifier contracts. Circuits MUST be compiled for the specific `N`. |

### Public Key Registration

```solidity
function registerPublicKey(uint256 x, uint256 y) external;
```

Any address MAY register a Baby Jubjub public key `(x, y)`. The key MUST be a valid point on the Baby Jubjub curve. A recipient MUST have a registered public key before tokens can be transferred to them via `verifiedTransferFrom`.

### Minting

```solidity
function mint(
    uint[2] calldata _pA,
    uint[2][2] calldata _pB,
    uint[2] calldata _pC,
    uint[S_a] calldata _pubSignals,
    address to
) external payable;
```

Where `S_a = 2C + 6`.

Minting MUST:

1. Require payment equal to the mint price.
2. Require `_pubSignals[S_a - 1] == 0` (mint mode — unconstrained slot changes).
3. Verify the Groth16 proof via the **AddData verifier**, proving the minter correctly encrypted valid plaintext data under their own keypair.
4. Store `_pubSignals[3 .. 3+C-1]` as the `C` ciphertext fields.
5. Set the timestamp to `_pubSignals[2]` and the flag to `true` (self-encrypted).

**Public Signals layout (AddData proof, `S_a = 2C + 6` signals):**

| Index             | Signal                                 |
|-------------------|----------------------------------------|
| 0                 | Recipient public key X                 |
| 1                 | Recipient public key Y                 |
| 2                 | Nonce (used as timestamp)              |
| 3 .. 3+C-1       | New ciphertext fields (C values)       |
| 3+C .. 3+2C-1    | Old ciphertext fields (C values)       |
| 3+2C              | Sender public key X                    |
| 3+2C+1            | Sender public key Y                    |
| 3+2C+2            | Mode flag (0=mint, 1=reCipher)         |

### Verified Transfer

```solidity
function verifiedTransferFrom(
    address from,
    address to,
    uint256 id,
    uint[2] calldata _pA,
    uint[2][2] calldata _pB,
    uint[2] calldata _pC,
    uint[S_t] calldata _pubSignals
) external;
```

Where `S_t = 2C + 5`.

A verified transfer MUST:

1. Verify that the old ciphertext fields stored on-chain match `_pubSignals[3+C .. 3+2C-1]`.
2. Verify that the recipient's registered public key matches `_pubSignals[0..1]`.
3. Verify the Groth16 proof via the **ECDH transfer verifier**, proving:
   - The sender knows the private key corresponding to their public key.
   - The sender decrypted the old ciphertext using the ECDH shared secret with the previous encryptor.
   - The sender re-encrypted the **same plaintext** for the recipient using a new ECDH shared secret.
4. Store `_pubSignals[3 .. 3+C-1]` as the new ciphertext fields.
5. Set the timestamp to `_pubSignals[2]` and the flag to `false` (ECDH-encrypted).
6. Execute the ERC-721 transfer.
7. Emit `VerifiedTransfer(senderPubKey, recipientPubKey, tokenId)`.

**Public Signals layout (ECDH Transfer proof, `S_t = 2C + 5` signals):**

| Index             | Signal                                 |
|-------------------|----------------------------------------|
| 0                 | Recipient public key X                 |
| 1                 | Recipient public key Y                 |
| 2                 | Nonce (used as timestamp)              |
| 3 .. 3+C-1       | New ciphertext fields (C values)       |
| 3+C .. 3+2C-1    | Old ciphertext fields (C values)       |
| 3+2C              | Sender public key X                    |
| 3+2C+1            | Sender public key Y                    |

### Re-Cipher

```solidity
function reCipher(
    uint[2] calldata _pA,
    uint[2][2] calldata _pB,
    uint[2] calldata _pC,
    uint[S_a] calldata _pubSignals,
    uint256 id
) external;
```

After receiving a token via `verifiedTransferFrom`, the new owner MAY re-encrypt the data under their own keypair. This MUST:

1. Require `msg.sender == ownerOf(id)`.
2. Require `_pubSignals[S_a - 1] == 1` (reCipher mode).
3. Require the token's flag is `false` (token was ECDH-encrypted, not yet re-ciphered).
4. Verify that old ciphertext fields match `_pubSignals[3+C .. 3+2C-1]`.
5. Verify the Groth16 proof via the **AddData verifier**.
6. Store the new ciphertext and set the flag to `true`.

Implementations MAY use the reCipher mode to enforce application-specific mutation constraints (e.g., at most one logical parameter changed between old and new plaintext). Such constraints are encoded in the AddData circuit and are OPTIONAL extensions to this standard.

### Disabled Transfer Functions

The following functions MUST revert unconditionally:

```solidity
function transferFrom(address from, address to, uint256 id) external payable;
function safeTransferFrom(address from, address to, uint256 id) external payable;
function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external payable;
```

### Events

```solidity
event VerifiedTransfer(uint256[2] indexed from, uint256[2] indexed to, uint256 indexed id);
```

Emitted on every `verifiedTransferFrom`, containing the Baby Jubjub public keys of sender and recipient.

### Verifier Upgradeability

The contract owner MAY update verifier contracts via:

```solidity
function updateVerifiers(address _ecdhVerifier, address _addDataVerifier) external;
```

Each update increments a `verifierVersion` counter and emits `VerifiersUpdated`.

### Interface

A compliant contract MUST expose the following view function so consumers can determine the note size:

```solidity
/// @notice Returns the number of plaintext field elements (N) this contract was deployed with.
/// @dev C = ceil(N/3)*3 + 1 ciphertext fields are stored per token.
function plaintextLength() external view returns (uint256);
```

A compliant contract SHOULD also expose:

```solidity
/// @notice Returns the number of ciphertext uint256 fields stored per token.
function ciphertextLength() external view returns (uint256);

/// @notice Returns all ciphertext fields and metadata for a token.
/// @return ciphertext Array of C uint256 ciphertext values
/// @return timestamp Encryption timestamp
/// @return flag Encryption method flag (true = self-encrypted, false = ECDH)
function getEncryptedNote(uint256 tokenId) external view returns (
    uint256[] memory ciphertext,
    uint256 timestamp,
    bool flag
);
```

## Zero-Knowledge Circuits

The system uses four main circuit families, all compiled with Circom 2.x and proven/verified with Groth16 (snarkjs + BN254). Each circuit is parameterized by `N` at compile time.

### 1. ECDH Key Exchange (`Ecdh`)

Computes a shared secret on the Baby Jubjub curve. This circuit is independent of `N`.

- **Private inputs**: `privateKey`
- **Public inputs**: `publicKey[2]`
- **Output**: `sharedKey[2]`
- **Operation**: Converts `privateKey` to a 253-bit binary representation, then performs scalar multiplication `sharedKey = privateKey * publicKey` using `EscalarMulAny`. The private key MUST first be processed through `deriveSecretScalar` (from `@zk-kit/eddsa-poseidon`) to ensure it is correctly hashed and pruned for the Baby Jubjub curve.

### 2. Poseidon Cipher (`PoseidonEncrypt(N)` / `PoseidonDecrypt(N)`)

Symmetric encryption using the Poseidon sponge permutation. Parameterized by `N`.

- **Encryption inputs**: `message[N]`, `nonce`, `key[2]`
- **Encryption output**: `ciphertext[C]` where `C = ceil(N/3)*3 + 1`
- **Operation**: Initializes a 4-element Poseidon state as `[0, key[0], key[1], nonce + (N << 128)]`. For each 3-element block of the (zero-padded) message, adds the permutation output to produce ciphertext, then feeds ciphertext back into the state. The `(C)`-th element is an **authentication tag**. The nonce MUST be less than 2^128.

Decryption is the inverse: subtracts permutation output from ciphertext to recover plaintext, and verifies the authentication tag.

The number of Poseidon permutation rounds is `ceil(N/3)`, so constraint count scales linearly with `N`.

### 3. ECDH + Poseidon Transfer Circuit (`EcdhPoseidonTransfer(N)`)

The main transfer circuit that proves correct decryption and re-encryption. Used by `verifiedTransferFrom`. Parameterized by `N`.

- **Private inputs**: `myPrivateKey`, `oldResultKey[2]`, `newResultKey[2]`, `oldMessage[N]`, `newMessage[N]`, `oldNonce`, `newNonce`
- **Public inputs**: `newReciverPublicKey[2]`, `oldSenderPublicKey[2]`, `oldComputedCipherText[C]`, `newComputedCipherText[C]`, `myPublicKey[2]`
- **Constraints**:
  1. **Key derivation**: Derives `myPublicKey` from `myPrivateKey` using `BabyPbk()` and constrains equality, proving the prover owns the private key.
  2. **Decrypt old ciphertext**: Computes `ECDH(myPrivateKey, oldSenderPublicKey)`, verifies it equals `oldResultKey`, then decrypts `oldComputedCipherText` with `PoseidonDecrypt(N)` using the shared key and `oldNonce`. Constrains that the decrypted output equals `oldMessage`.
  3. **Encrypt new ciphertext**: Computes `ECDH(myPrivateKey, newReciverPublicKey)`, verifies it equals `newResultKey`, then encrypts `newMessage` with `PoseidonEncrypt(N)` using the new shared key and `newNonce`. Constrains that the encryption output equals `newComputedCipherText`.

This ensures that the plaintext was correctly decrypted from the old ciphertext and re-encrypted for the new recipient, without revealing any plaintext or private keys on-chain.

### 4. Add/Update Data Circuit (`AddNewDataEncrypt(N)`)

Used for minting and re-ciphering. Proves correct encryption of (optionally validated) plaintext. Parameterized by `N`.

- **Private inputs**: `myPrivateKey`, `oldResultKey[2]`, `newResultKey[2]`, `oldMessage[N]`, `newMessage[N]`, `oldNonce`, `newNonce`
- **Public inputs**: `newReciverPublicKey[2]`, `oldSenderPublicKey[2]`, `oldComputedCipherText[C]`, `newComputedCipherText[C]`, `myPublicKey[2]`, `enableOneValueCheck`
- **Constraints**:
  1. **Key derivation**: Same as the transfer circuit — proves ownership of `myPrivateKey`.
  2. **Decrypt old ciphertext**: Decrypts the old ciphertext using ECDH + `PoseidonDecrypt(N)` and verifies plaintext integrity.
  3. **Plaintext validation** (OPTIONAL, application-specific): Implementations MAY include a sub-circuit that validates the `N` plaintext elements conform to an application-specific schema. This is NOT part of the core standard but is a recommended extension point. See [Application-Specific Validation](#application-specific-validation) for an example.
  4. **Encrypt new ciphertext**: Encrypts the new plaintext for the recipient using `PoseidonEncrypt(N)` and constrains correctness.
  5. **Mutation guard** (OPTIONAL): When `enableOneValueCheck == 1` (reCipher mode), implementations MAY constrain the number of plaintext elements that changed between old and new data. When `enableOneValueCheck == 0` (mint mode), this check is bypassed.

### Circuit Composition Diagram

```
verifiedTransferFrom (on-chain)
  └─ ECDH Transfer Verifier
       └─ EcdhPoseidonTransfer(N) (circuit)
            ├─ BabyPbk()                ← derive pubkey from privkey
            ├─ EcdhPoseidonDecrypt()    ← decrypt old ciphertext
            │    ├─ Ecdh()              ← shared secret with old sender
            │    └─ PoseidonDecrypt(N)  ← symmetric decryption
            └─ EcdhPoseidonEncrypt()    ← encrypt for new recipient
                 ├─ Ecdh()              ← shared secret with recipient
                 └─ PoseidonEncrypt(N)  ← symmetric encryption

mint / reCipher (on-chain)
  └─ AddData Verifier
       └─ AddNewDataEncrypt(N) (circuit)
            ├─ BabyPbk()                ← derive pubkey from privkey
            ├─ EcdhPoseidonDecrypt()    ← decrypt old ciphertext
            │    ├─ Ecdh()              ← shared secret
            │    └─ PoseidonDecrypt(N)  ← symmetric decryption
            ├─ [ValidatePlaintext()]    ← OPTIONAL: app-specific schema check
            ├─ EcdhPoseidonEncrypt()    ← encrypt new ciphertext
            │    ├─ Ecdh()              ← shared secret
            │    └─ PoseidonEncrypt(N)  ← symmetric encryption
            └─ [MutationGuard()]        ← OPTIONAL: constrain changes
```

### Application-Specific Validation

The core standard does not mandate any particular plaintext schema. However, implementations are RECOMMENDED to include a validation sub-circuit in the AddData circuit that constrains the `N` plaintext elements to a valid domain.

As an example, a generative art implementation with `N=3` might validate Turmite parameters:

- **Slot 1** (`message[0]`): 15 position pairs (x, y coordinates), each coordinate 8 bits, total 240 bits used out of 254.
- **Slot 2** (`message[1]`): 3 position pairs (48 bits) + 2 rulesets of 4 rules each (192 bits). Each rule: state byte {0,1}, direction byte {0,2,4,8}, color byte {0,255}.
- **Slot 3** (`message[2]`): 2 position pairs (32 bits) + 2 rulesets (192 bits) + 3 metadata bytes (24 bits) + 1 color nibble (4 bits).

The validation circuit bit-decomposes each slot and checks that extracted values fall within their allowed sets. A mutation guard additionally constrains that at most one logical parameter changes during reCipher.

### Constraint Count Scaling

The dominant cost in constraint count scales linearly with `N`:

| Component (per invocation)    | Approximate constraints | Scaling     |
|-------------------------------|------------------------|-------------|
| `Ecdh()`                     | ~7,600                 | Constant    |
| `BabyPbk()`                  | ~3,800                 | Constant    |
| `PoseidonEncrypt(N)` / `PoseidonDecrypt(N)` | ~300 * ceil(N/3) | Linear in N |
| Full transfer circuit         | ~22,800 + 600*ceil(N/3) | Linear in N |

Implementers SHOULD choose `N` to balance data capacity against proof generation time and verifier gas cost. For client-side proof generation in a browser, `N <= 15` is RECOMMENDED.

## Rationale

### Why parameterize over N?

Different applications need different amounts of encrypted data per token. A single encrypted field suffices for a secret seed; generative art may need 3–6 slots; a rich metadata schema might need 9+. By parameterizing the standard over `N`, implementations share the same architecture, interface conventions, and security properties while adapting storage to their domain. The Poseidon cipher and Groth16 circuits naturally support this parameterization since `PoseidonEncrypt(length)` already accepts a compile-time length parameter.

### Why disable standard transfers?

Standard `transferFrom` would move the token without re-encrypting its data. The new owner would possess a token whose metadata they cannot decrypt (it's encrypted for the old owner). Disabling standard transfers and requiring `verifiedTransferFrom` ensures that every transfer atomically re-encrypts metadata for the recipient.

### Why Poseidon encryption?

Poseidon is a zkSNARK-friendly hash function designed for arithmetic circuits over prime fields. It achieves dramatically lower constraint counts compared to SHA-256 or other hash functions when used inside circom circuits. The Poseidon sponge construction naturally extends to authenticated encryption, providing both confidentiality and integrity. Its block-based design means scaling to larger `N` adds constraints linearly rather than quadratically.

### Why Baby Jubjub?

Baby Jubjub is an elliptic curve embedded in the BN254 scalar field, making scalar multiplication and point operations efficiently expressible as R1CS constraints. This allows ECDH key exchange to be proven inside a Groth16 circuit with reasonable constraint counts.

### Why on-chain ciphertext?

Storing ciphertext on-chain makes the encrypted data fully self-sovereign — no external storage or availability assumptions are needed. The token and its encrypted data are atomic. Anyone can verify the ciphertext exists; only the holder of the corresponding private key can decrypt it.

### Why a re-cipher step?

After `verifiedTransferFrom`, the token's data is encrypted under the ECDH shared secret between sender and recipient. The `reCipher` operation lets the owner re-encrypt under a purely self-derived key, removing any dependency on the sender's keypair for future decryption. It also provides an extension point for controlled mutation.

### Why separate plaintext validation from the core standard?

Plaintext validation is inherently application-specific — generative art validates rulesets, a credential system validates schema fields, a game validates state transitions. By making validation an optional sub-circuit rather than a core requirement, the standard remains general while allowing implementations to enforce domain integrity within the same proof.

## Security Considerations

### Private Key Management

Users' Baby Jubjub private keys are never submitted on-chain — they remain as private inputs to the ZK circuits. However, compromise of a private key would allow decryption of all data encrypted for that key. Key rotation requires a `reCipher` operation.

### Proof Malleability

Groth16 proofs are malleable. The on-chain verifier checks that old ciphertext matches stored values and that recipient public keys match registered keys, preventing replay of proofs with altered public signals.

### Front-Running

Since `verifiedTransferFrom` includes the proof and new ciphertext in the transaction calldata, a front-runner could observe and extract the new ciphertext. However, the ciphertext is only decryptable by the holder of the recipient's private key, so front-running does not leak plaintext.

### Verifier Upgradeability

The contract owner can replace verifier contracts. A malicious owner could deploy a verifier that accepts invalid proofs. Users SHOULD verify that deployed verifier contracts match the expected circuit verification keys.

### Ciphertext on Public Chain

All ciphertext is publicly visible on-chain. The security of the encrypted data relies entirely on the hardness of the discrete logarithm problem on Baby Jubjub and the security of the Poseidon cipher. If either primitive is broken, all historical ciphertext becomes decryptable.

### Scaling N

Larger `N` values increase proof generation time, calldata size, and verifier gas cost. Implementations SHOULD document their chosen `N` and the corresponding gas and performance characteristics. An excessively large `N` may make client-side proof generation impractical.

### Plaintext Field Size

Each plaintext element is a BN254 scalar field element (< 2^254). Applications that pack sub-field data (e.g., bytes, coordinates) into a single field element SHOULD validate the packing in the circuit to prevent overflow or misinterpretation.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE.md).
