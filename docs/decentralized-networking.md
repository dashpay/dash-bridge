# Bridge networking model

The bridge does not use Insight, a hosted transaction broadcaster, or a
Digital Cash JSON-RPC relay. Core reads and broadcasts use the Dash DAPI gRPC
client. Deposit detection and InstantSend lock delivery use
`subscribeToTransactionsWithProofs`; chain-lock recovery reads Platform status
from the same DAPI connection.

Public networks use the DAPI client's normal seed and masternode-list address
rotation. Custom devnets store an explicit list of DAPI masternode addresses.
Every transaction is signed in the browser and submitted directly to a DAPI
masternode. No private key or transaction is sent to an application-owned
backend.

The Platform SDK still uses its proof-verifying trusted context for public
identity and credit operations. That context is Dash quorum data, not an
Insight-style transaction service; it is required by the SDK to verify
Platform proofs. A future fully self-verified mode would need to ship and
maintain quorum snapshots in the client.

When DAPI cannot return an InstantSend lock, the bridge does not rebroadcast.
It waits for the original transaction to be mined and for Platform to report
the corresponding Core chain lock, then submits a chain asset-lock proof for
that same transaction.
