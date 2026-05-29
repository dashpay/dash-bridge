# Dash Bridge

A non-custodial bridge for converting Dash Core funds to Dash Platform credits.

## Features

- Client-side only - all cryptographic operations happen in your browser
- Supports both testnet and mainnet (via `?network=mainnet` URL parameter)
- HD wallet support with BIP39 mnemonic generation
- QR code generation for deposit addresses

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Playwright E2E

This repository includes two E2E modes:

- Deterministic UI mode (CI-safe): runs against `?e2e=mock` with no live funds/keys required.
- Optional live testnet mode: runs against testnet endpoints with real identity/key validation and realistic click-through.

### Install browser for E2E

```bash
npm run test:e2e:install
```

### Deterministic E2E (used in CI)

```bash
# Headless
npm run test:e2e

# Headed (local debugging)
npm run test:e2e:headed
```

### Optional live testnet E2E

Live suite is opt-in and skips when required variables are missing.
Never paste real private keys directly inline in shell commands. Inline secrets are saved in shell history.

```bash
# Safer approach: store sensitive values in a protected env file and source it
cat > .env.playwright-live <<'EOF'
PW_E2E_LIVE=1
PW_LIVE_TOPUP_IDENTITY_ID=<44-char-base58-id>
PW_LIVE_DPNS_IDENTITY_ID=<44-char-base58-id>
PW_LIVE_DPNS_PRIVATE_KEY_WIF=<wif-auth-key>
PW_LIVE_MANAGE_IDENTITY_ID=<44-char-base58-id>
PW_LIVE_MANAGE_PRIVATE_KEY_WIF=<wif-master-key>
EOF

chmod 600 .env.playwright-live
set -a
source .env.playwright-live
set +a
npm run test:e2e:live
```

Environment variables used by the live suite:

- `PW_E2E_LIVE`: set to `1` to enable live tests.
- `PW_LIVE_TOPUP_IDENTITY_ID`: identity ID used for top-up navigation check.
- `PW_LIVE_DPNS_IDENTITY_ID`: identity ID used for DPNS key validation.
- `PW_LIVE_DPNS_PRIVATE_KEY_WIF`: DPNS AUTHENTICATION key for that identity. Prefer CRITICAL; HIGH is also accepted.
- `PW_LIVE_MANAGE_IDENTITY_ID`: identity ID used for key-management validation.
- `PW_LIVE_MANAGE_PRIVATE_KEY_WIF`: MASTER key for identity-management validation.
- `PLAYWRIGHT_BASE_URL` (optional): override app URL if running against a pre-started server.
- `PLAYWRIGHT_HOST` / `PLAYWRIGHT_PORT` (optional): host/port used by Playwright-managed dev server.

## Deployment

This project automatically deploys to GitHub Pages on push to `main` via GitHub Actions.

## License

MIT
