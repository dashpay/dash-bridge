/* eslint-disable @typescript-eslint/no-explicit-any */
import dashcoreLib from '@dashevo/dashcore-lib';
import { describe, expect, it } from 'vitest';

import { evonodeEndpointsFromSml } from './evonode-discovery.js';

// Real dashcore-lib entries (only the fields getPlatformHTTPSEndpoint reads),
// so a change in how the library derives the Platform endpoint shows up here.
const { SimplifiedMNListEntry } = dashcoreLib as any;
const entry = (fields: Record<string, unknown>) =>
  Object.assign(Object.create(SimplifiedMNListEntry.prototype), fields);

describe('evonodeEndpointsFromSml with dashcore-lib entries', () => {
  it('uses service ip + platformHTTPPort for older evonodes and platform_https for extended-address ones', () => {
    const sml = {
      getValidMasternodesList: () => [
        entry({ nType: 1, nVersion: 2, service: '68.67.122.1:19999', platformHTTPPort: 1443 }),
        // Regular masternode: serves no DAPI.
        entry({ nType: 0, nVersion: 2, service: '68.67.122.2:19999' }),
        // Extended addresses: the DAPI host differs from the Core P2P host.
        entry({
          nType: 1,
          nVersion: 3,
          service: '68.67.122.3:19999',
          addresses: { core_p2p: ['68.67.122.3:19999'], platform_https: ['evo3.example.org:443'] },
        }),
        entry({ nType: 1, nVersion: 2, service: '0.0.0.0:0', platformHTTPPort: 1443 }),
      ],
    };

    expect(evonodeEndpointsFromSml(sml)).toEqual(['https://68.67.122.1:1443', 'https://evo3.example.org:443']);
  });
});
