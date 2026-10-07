import { describe, it, expect } from 'vitest';
import { createKeyBackup } from './components.js';
import { createInitialState, setError } from './state.js';
import { IdentityRegistrationUnconfirmedError } from '../platform/identity-confirm.js';

describe('createKeyBackup', () => {
  it('includes the derived identity ID of an unconfirmed registration, marked as unconfirmed', () => {
    const errored = setError(
      { ...createInitialState('testnet'), step: 'registering_identity' },
      new IdentityRegistrationUnconfirmedError('someIdentityId')
    );
    const backup = JSON.parse(createKeyBackup(errored));
    expect(backup.identityId).toBe('someIdentityId');
    expect(backup.identityStatus).toBe('submitted, not yet confirmed');
  });

  it('does not mark a completed identity as unconfirmed', () => {
    const backup = JSON.parse(createKeyBackup({ ...createInitialState('testnet'), identityId: 'doneId' }));
    expect(backup.identityId).toBe('doneId');
    expect(backup.identityStatus).toBeUndefined();
  });
});
