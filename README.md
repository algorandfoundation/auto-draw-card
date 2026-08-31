# auto-draw-card

## About this project

`auto-draw-card` implements an Algorand card-management system. A **Main** contract "generates" a rekeyed account for each card it creates, and all minimum balance requirements (box storage, account minimums, asset opt-in MBR) are pre-funded by the contract owner — the **Partner** operating the platform. Callers never attach MBR payments.

On top of the Main contract, two auxiliary components enable an opt-in automated debit ("AutoDraw") flow that card holders can disable at any time:

- **Main** — the card-management application (create/close/recover cards, debits, withdrawals).
- **Killswitch** — an application tracking which accounts have opted in to AutoDraw delegation.
- **AutoDraw** — a delegated `LogicSig` that authorizes an automatic debit from a card, gated by the Killswitch.

## ⚠️ Disclaimer — not audited, not for production

**These contracts have not been audited and must not be used in production.** They are one component of a larger platform and are intended to operate together with non-public, off-chain logic — card issuance, card-network authorization, withdrawal signing, and escrow funding. Deployed on their own they are neither complete nor safe.

The contracts assume the following, none of which is enforced on-chain:

- **One active card per holder.** The Partner enforces this off-chain at card issuance. The contracts deliberately permit a holder to own several cards (`cardRecover` can produce that state directly), and the on-chain logic stays correct when they do — but some effects are intentionally holder-wide rather than per-card: a holder has a single withdrawal-request slot covering all of their cards, and revoking a holder's AutoDraw delegation applies to every card they own.
- **A fully trusted operator.** The owner can update or destroy the contract, reassign any card (`cardRecover`), and sweep any asset it holds (`recoverAsset`). The Partner, withdraw operators, and pauser are assumed to be operational keys of the same trusted platform.
- **An owner-funded escrow.** All minimum balance requirements are paid from the contract's balance; the owner must keep it funded off-chain.
- **Off-chain signing and authorization services.** Debits are initiated by off-chain card-network authorization logic, permissioned withdrawals depend on an off-chain service holding the withdrawal ed25519 key, and signed AutoDraw delegations are produced and held off-chain (the Killswitch is the holder's on-chain control over them).

The authoritative statement of the trust model is the comment block above `export class Main` in [`projects/auto-draw-card/smart_contracts/main/contract.algo.ts`](projects/auto-draw-card/smart_contracts/main/contract.algo.ts); see also the project README's [Design assumptions](projects/auto-draw-card/README.md#design-assumptions).

## Repository layout

This is an [AlgoKit](https://github.com/algorandfoundation/algokit-cli) workspace. The smart contracts live in [`projects/auto-draw-card`](projects/auto-draw-card/README.md) — see that project's README for setup instructions and the full contract reference, role model, and lifecycle diagrams.
