# Dash Bridge

[![CI](https://github.com/PastaPastaPasta/dash-bridge/actions/workflows/deploy.yml/badge.svg)](https://github.com/PastaPastaPasta/dash-bridge/actions/workflows/deploy.yml)
![Evo SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FPastaPastaPasta%2Fdash-bridge%2Fmain%2Fpackage.json&query=%24.dependencies%5B%22%40dashevo%2Fevo-sdk%22%5D&label=%40dashevo%2Fevo-sdk&color=blue)

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

## Deployment

This project automatically deploys to GitHub Pages on push to `main` via GitHub Actions.

## License

MIT
