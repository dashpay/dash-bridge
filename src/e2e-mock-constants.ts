/**
 * Structurally valid identity IDs: Base58 decoding to exactly 32 bytes, so
 * mock-mode runs exercise the same identifier validation as a real network.
 */
export const E2E_MOCK_IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';
export const E2E_MOCK_DPNS_WIF = 'cMockDpnsPrivateKeyWif';
export const E2E_MOCK_MANAGE_WIF = 'cMockManagePrivateKeyWif';
export const E2E_MOCK_WITHDRAW_WIF = 'cMockWithdrawPrivateKeyWif';
/** A structurally valid testnet P2PKH address (prefix 140) so address validation runs for real in mock mode. */
export const E2E_MOCK_WITHDRAW_ADDRESS = 'ySMnpcCKx4wD57T5dhjz3t3im3hgaQ5JYG';
/** Mock identity balance in credits (0.25 DASH). */
export const E2E_MOCK_WITHDRAW_BALANCE = 25_000_000_000;
export const E2E_MOCK_XFER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const E2E_MOCK_XFER_RECIPIENT_ID = '4uvqP8FNZCyqYgPe3GUxP18RWdiLqxne1h4d4byFhdqK';

/**
 * Sign in with Dash: keys of the mock identity (E2E_MOCK_IDENTITY_ID). Real
 * testnet WIFs (private key = sha256("dash-bridge-e2e-login-<label>")), so
 * mock mode signs for real and the result verifies against these keys.
 */
export const E2E_MOCK_LOGIN_MASTER_WIF = 'cVVRKFJ4NydrByDATRD3ccnkUwKJBV8KLC2qJpSxDhAn6jpomutx';
export const E2E_MOCK_LOGIN_HIGH_WIF = 'cNo3S8f7ivbM1QLXVNHv39kDUNmnPj1MDxqDNk6477wd2wu9kH6w';
export const E2E_MOCK_LOGIN_HASH160_WIF = 'cNSzvJYLZSVyc4EQhDfWT6pAtN7H4bcn8oqpxgY1PGfUME6JYcNh';
export const E2E_MOCK_LOGIN_TRANSFER_WIF = 'cUpwADck3oAXFLsKCLJFdFknKWY5hNZT5yzfGHSSDMW4gxjaNprq';
/** Same shape as evo-sdk's `identity.toJSON().publicKeys` (but `data` as hex). */
export const E2E_MOCK_LOGIN_PUBLIC_KEYS = [
  // MASTER AUTHENTICATION
  { id: 0, type: 0, purpose: 0, securityLevel: 0, data: '030c08ed76fa913abf5940a30f98342c101b0d0a3f611af2a8e7fd83fe52979b96' },
  // HIGH AUTHENTICATION
  { id: 1, type: 0, purpose: 0, securityLevel: 2, data: '035f1beb3395abaf66d156f8a1ad0feed53df8df5bd3ce75d325c82c456c6fea67' },
  // CRITICAL AUTHENTICATION, ECDSA_HASH160
  { id: 2, type: 2, purpose: 0, securityLevel: 1, data: 'd5c64c772f4df619b66c466a146a544a2d286f3d' },
  // CRITICAL TRANSFER
  { id: 3, type: 0, purpose: 3, securityLevel: 1, data: '03d6ff03ad3f9f8c9bf7895fb7500456531fd107e85dc06ee2099fc2d8130044db' },
];
