# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Non-custodial browser-based bridge for converting Dash Core funds to Dash Platform credits. All cryptographic operations happen client-side; keys never leave the browser.

## Commands

```bash
npm install      # Install dependencies
npm run dev      # Start Vite dev server
npm run build    # TypeScript check + Vite production build
npm run test     # Run Vitest tests
```

## Architecture

The main codebase is TypeScript in `src/` (Vite + TypeScript). There's also a `v2/` directory with a JavaScript-based alternative implementation using `@dashevo/dashcore-lib` and `dash` SDK directly.

### Source Structure (src/)

```
src/
├── main.ts              # Entry point, UI orchestration, state management
├── config.ts            # Network configuration (testnet/mainnet)
├── types.ts             # TypeScript interfaces (KeyPair, UTXO, BridgeState, etc.)
├── crypto/              # Cryptographic operations
│   ├── keys.ts          # Key generation (secp256k1)
│   ├── hd.ts            # HD wallet derivation (BIP32/BIP39)
│   ├── address.ts       # Address derivation from public keys
│   ├── hash.ts          # Hash functions (SHA256, RIPEMD160)
│   └── signing.ts       # Transaction signing
├── transaction/         # Dash transaction handling
│   ├── builder.ts       # Asset lock transaction construction (Type 8)
│   ├── serialize.ts     # Transaction serialization
│   ├── sighash.ts       # Signature hash computation
│   └── structures.ts    # Transaction data structures
├── proof/               # Asset lock proof construction
│   └── builder.ts       # InstantSend lock proof building
├── api/                 # Network communication
│   ├── insight.ts       # Insight API client (UTXO fetching, broadcast)
│   └── dapi.ts          # DAPI client (Platform operations, InstantSend)
├── platform/            # Dash Platform operations
│   ├── identity.ts      # Identity registration and top-up
│   └── login.ts         # Sign in with Dash: key checks and signing
├── embed/               # Embed mode for third-party apps (docs/widget.md)
│   ├── protocol.ts      # Shared postMessage protocol + URL param validation
│   ├── bridge.ts        # Bridge side: framing guard, EmbedSession messaging
│   └── login.ts         # Sign in with Dash: message format, redirect fragments
├── widget/              # widget.js SDK (separate lib build: vite.widget.config.ts)
│   └── verify.ts        # verifyLogin -> dist/widget-verify.mjs (vite.verify.config.ts)
└── ui/                  # UI layer
    ├── state.ts         # State machine and state transitions
    ├── components.ts    # UI rendering
    └── qrcode.ts        # QR code generation
```

### Key Flows

**Identity Creation (create mode):**
1. Generate HD wallet from mnemonic → derive asset lock keypair
2. Display deposit address with QR code
3. Poll Insight API for UTXO → build Type 8 asset lock transaction
4. Sign transaction locally → broadcast via Insight
5. Wait for InstantSend lock via DAPI → build asset lock proof
6. Register identity on Platform with configured identity keys

**Top-up Mode:**
Uses random one-time keypair (not HD-derived) to add credits to an existing identity.

### Key Types

- `KeyType`: ECDSA_SECP256K1 | ECDSA_HASH160
- `KeyPurpose`: AUTHENTICATION | TRANSFER | VOTING | OWNER
- `SecurityLevel`: MASTER | CRITICAL | HIGH | MEDIUM
- `BridgeMode`: create | topup

### Network Selection

Network is determined by URL parameter: `?network=mainnet` (defaults to testnet).

## Dependencies

Core dependencies: `@dashevo/evo-sdk`, `@noble/hashes`, `@noble/secp256k1`, `@scure/bip32`, `@scure/bip39`, `bs58check`, `qrcode`
