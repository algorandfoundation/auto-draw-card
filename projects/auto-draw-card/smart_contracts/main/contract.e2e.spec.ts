import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import algosdk from 'algosdk'
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import { KillswitchClient } from '../artifacts/killswitch/KillswitchClient'
import type { WithdrawalRequest } from '../artifacts/main/MainClient'
import { MainClient } from '../artifacts/main/MainClient'
import { deploy as deployKillswitch } from '../killswitch/deploy-config'
import { deploy as deployMain } from './deploy-config'

const testDir = dirname(fileURLToPath(import.meta.url))

/**
 * Sign an arbitrary message with ed25519 using only Node's built-in crypto.
 *
 * An algosdk secret key is the 64-byte concatenation of the 32-byte ed25519 seed and the
 * 32-byte public key. Node's crypto needs the seed wrapped in a PKCS#8 DER document, so we
 * prefix the seed with the standard ed25519 PKCS#8 header and import it as a private key.
 */
function ed25519SignDetached(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const seed = Buffer.from(secretKey.slice(0, 32))
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  return new Uint8Array(cryptoSign(null, Buffer.from(message), key))
}

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.MicroAlgos(0) })

let appClient: MainClient
let ksClient: KillswitchClient

describe('Auto-Draw Card', () => {
  let circle: algosdk.Account & algosdk.Address
  let owner: algosdk.Account & algosdk.Address
  let user: algosdk.Account & algosdk.Address
  let user2: algosdk.Account & algosdk.Address
  let withdrawalAcc: algosdk.Account & algosdk.Address
  let omnibus: algosdk.Account & algosdk.Address
  // Account authorized via `addWithdrawOperator` to call `cardDebit`. Deliberately not the
  // contract owner, so every debit below proves the gate is the operator box and not ownership.
  let withdrawOperator: algosdk.Account & algosdk.Address

  // MBR the app account locks up per withdraw-operator box:
  // 2500 + 400 * (keyPrefix 'wop' (3) + address (32) + uint64 value (8)) = 19_700
  const WITHDRAW_OPERATOR_BOX_MBR = 19_700n

  let fakeUSDC: bigint
  let newCardAddress: string
  let withdrawalRequest: WithdrawalRequest

  // AutoDraw-specific state (uses a separate card so the main flow stays intact)
  let autoDrawCardAddress: string
  let autoDrawLsig: algosdk.LogicSigAccount
  const AUTO_DRAW_DEBIT_AMOUNT = 5_000_000n

  // Withdrawal card-binding state: two cards owned by the same holder, needed because the
  // withdrawal request box is keyed by sender rather than by card.
  let bindingCardA: string
  let bindingCardB: string
  let bindingRequest: WithdrawalRequest
  const BINDING_FUND_AMOUNT = 4_000_000n

  beforeAll(async () => {
    await fixture.newScope()
    Config.configure({ populateAppCallResources: true })
    const { algorand, generateAccount } = fixture.context

    ;[owner, user, user2, circle, withdrawalAcc, omnibus, withdrawOperator] = await Promise.all([
      generateAccount({ initialFunds: AlgoAmount.Algos(100) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
      generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
    ])

    // Create FakeUSDC
    const created = await algorand.send.assetCreate({
      sender: circle.addr,
      assetName: 'FakeUSDC',
      unitName: 'FUSDC',
      total: BigInt(2) ** BigInt(64) - BigInt(1),
      decimals: 6,
      defaultFrozen: false,
      manager: circle.addr,
      reserve: circle.addr,
      freeze: circle.addr,
    })
    fakeUSDC = created.assetId

    // OptIn and Send FUSDC
    await Promise.all([
      algorand.send.assetOptIn({ sender: owner.addr, assetId: fakeUSDC }),
      algorand.send.assetOptIn({ sender: user.addr, assetId: fakeUSDC }),
      algorand.send.assetOptIn({ sender: user2.addr, assetId: fakeUSDC }),
      algorand.send.assetOptIn({ sender: omnibus.addr, assetId: fakeUSDC }),
    ])
    await algorand.send.assetTransfer({
      sender: circle.addr,
      receiver: user.addr,
      assetId: fakeUSDC,
      amount: 100_000_000n,
    })

    // Deploy the Main contract via the shared deploy-config
    appClient = await deployMain({
      algorand,
      deployer: owner.addr,
      owner: owner.addr.toString(),
      omnibus: omnibus.addr.toString(),
      fundAmount: AlgoAmount.MicroAlgos(10_000_000),
    })

    // Deploy the Killswitch contract (used by the AutoDraw delegation flow) via its deploy-config
    ksClient = await deployKillswitch({
      algorand,
      deployer: owner.addr,
      owner: owner.addr.toString(),
      mainAppId: appClient.appId,
      fundAmount: AlgoAmount.MicroAlgos(200_000),
    })
  })

  /**
   * Sets the withdrawal timeout to 0 seconds so the test suite can complete withdrawals
   * instantly. In production this value is the mandatory delay between requesting and
   * completing a withdrawal (e.g. 5 days = 432_000 seconds), giving Partner time to react
   * to fraud before funds leave a card.
   */
  test('Set withdrawal rounds to 0', async () => {
    // A real value would be:
    // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
    // We're using 0 seconds to allow for instant withdrawals
    const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 0 } })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Registers the ed25519 public key whose signatures authorize permissioned
   * withdrawals. The matching private key lives off-chain with Partner; the contract verifies
   * signatures against this key in `withdrawPermissioned` to let users skip the timeout.
   */
  test('Set withdrawal public key', async () => {
    const result = await appClient.send.setWithdrawalPubkey({
      args: { pubkey: withdrawalAcc.addr.publicKey },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Registers the partner address that operates the card lifecycle. Partner-gated
   * methods (`cardCreate`, `cardAssetOptIn`, `cardClose`, `cardDisableAsset`) read this
   * global state, so it must be set before any card is created. The owner account
   * doubles as the partner for the rest of the suite.
   */
  test('Set partner address', async () => {
    const result = await appClient.send.setPartnerAddress({
      args: { newPartnerAddress: owner.addr.toString() },
    })

    expect(result.confirmation.poolError).toBe('')
    expect(await appClient.state.global.partnerAddress()).toBe(owner.addr.toString())
  })

  /**
   * Negative case for the partner gate: only the owner can rotate the partner address,
   * so a random account is rejected with the Ownable error.
   */
  test('setPartnerAddress fails for non-owner', async () => {
    await expect(
      appClient.send.setPartnerAddress({
        args: { newPartnerAddress: user2.addr.toString() },
        sender: user2.addr,
      }),
    ).rejects.toThrow()
  })

  /**
   * Negative case for the withdraw-operator registry: authorizing an account to debit cards is
   * the most powerful grant the contract makes, so only the owner may make it. A non-owner
   * self-authorizing is rejected by the Ownable guard before any box is written.
   */
  test('addWithdrawOperator fails for non-owner', async () => {
    await expect(
      appClient.send.addWithdrawOperator({
        args: { operator: user2.addr.toString() },
        sender: user2.addr,
      }),
    ).rejects.toThrow()

    expect((await appClient.state.box.withdrawOperators.getMap()).has(user2.addr.toString())).toBe(false)
  })

  /**
   * Confirms the omnibus settlement address is persisted from the deploy arguments.
   * The omnibus account is where debited card funds ultimately settle, so it must be
   * readable on-chain immediately after creation.
   */
  test('Omnibus address set at deploy', async () => {
    const result = await appClient.state.global.omnibusAddress()

    expect(result).toBe(omnibus.addr.toString())
  })

  /**
   * Exercises the owner-only setter that rotates the omnibus address, reads it back to
   * confirm the change, then restores the original. Restoring matters because the rest of
   * the suite relies on the debit flow settling into the omnibus account that is opted in
   * to FakeUSDC.
   */
  test('Update and restore omnibus address', async () => {
    const updated = await appClient.send.setOmnibusAddress({
      args: { newOmnibusAddress: circle.addr.toString() },
    })
    expect(updated.confirmation.poolError).toBe('')

    expect(await appClient.state.global.omnibusAddress()).toBe(circle.addr.toString())

    // Restore so the debit flow settles into the opted-in omnibus account
    const restored = await appClient.send.setOmnibusAddress({
      args: { newOmnibusAddress: omnibus.addr.toString() },
    })
    expect(restored.confirmation.poolError).toBe('')
  })

  /**
   * Verifies the owner can sweep stray Algo (asset 0) that lands on the Main app account.
   * Funds a payment into the app, then recovers it to the Partner owner, guarding against
   * value being permanently stranded in the contract.
   */
  test('Recover Algo from Main', async () => {
    const { algorand } = fixture.context

    await algorand.send.payment({
      sender: owner.addr,
      receiver: appClient.appAddress,
      amount: AlgoAmount.MicroAlgos(1_000_000),
    })

    const recover = await appClient.send.recoverAsset({
      args: {
        amount: 1_000_000,
        asset: 0,
        recipient: owner.addr.toString(),
      },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(recover.confirmation.poolError).toBe('')
  })

  /**
   * Negative case for the partner gate on card creation: an account that is not the
   * partner cannot mint cards, reverting with SENDER_NOT_ALLOWED.
   */
  test('cardCreate fails when called by non-partner', async () => {
    await expect(
      appClient.send.cardCreate({
        args: {
          cardOwner: user2.addr.toString(),
          asset: 0,
        },
        sender: user2.addr,
        staticFee: AlgoAmount.MicroAlgos(4_000),
      }),
    ).rejects.toThrow('SENDER_NOT_ALLOWED')
  })

  /**
   * Creates a card account for a holder without opting into any asset (asset 0). This is
   * the lightweight card-creation path; the returned address is the freshly minted card
   * account that can later be opted into assets or closed.
   */
  test('Create new card without assets', async () => {
    const result = await appClient.send.cardCreate({
      args: {
        cardOwner: user2.addr.toString(),
        asset: 0,
      },
      sender: owner.addr,
      staticFee: AlgoAmount.MicroAlgos(4_000),
    })
    expect(result.return).toBeDefined()

    newCardAddress = result.return!
  })

  /**
   * Closes the asset-less card created above and reclaims its minimum balance back to the
   * funder, confirming the create/close lifecycle works for cards holding no assets.
   */
  test('Close card without assets', async () => {
    const result = await appClient.send.cardClose({
      args: { card: newCardAddress },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Negative case for the card-existence guard in `cardAssetOptIn`: the partner cannot opt an
   * address that has no card box into an asset, because there would be no card to fund the
   * opt-in MBR or to authorize the inner transfer. Pins the guard so it cannot be dropped to
   * make the ordering test below pass.
   */
  test('cardAssetOptIn fails for an unknown card', async () => {
    await expect(
      appClient.send.cardAssetOptIn({
        args: {
          card: user2.addr.toString(),
          asset: fakeUSDC,
        },
        sender: owner.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('CARD_NOT_FOUND')
  })

  /**
   * Creates a card and opts it into FakeUSDC in a single call. The returned address is
   * reused throughout the main spend/withdraw flow below, so this card is the primary
   * subject of the asset-bearing tests.
   *
   * This is also the ordering regression test for `cardCreate`: `cardAssetOptIn` asserts the
   * card box exists, so the box write and the active-card increment must happen *before* the
   * opt-in. If the opt-in is hoisted above the box write, the whole call reverts with
   * CARD_NOT_FOUND and every assertion here fails. The holding and counter checks are what
   * make the ordering observable rather than merely implied by the call not throwing.
   */
  test('Create new card with FakeUSDC', async () => {
    const { algorand } = fixture.context

    const activeBefore = await appClient.state.global.cardsActiveCount()

    const result = await appClient.send.cardCreate({
      args: {
        cardOwner: user.addr.toString(),
        asset: fakeUSDC,
      },
      sender: owner.addr,
      staticFee: AlgoAmount.MicroAlgos(5_000),
    })
    expect(result.return).toBeDefined()

    newCardAddress = result.return!

    // The card box was written, with the generated address stored back into it.
    const cardData = await appClient.send.getCardData({
      args: { card: newCardAddress },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(cardData.return?.owner).toBe(user.addr.toString())
    expect(cardData.return?.address).toBe(newCardAddress)

    // The active-card counter was incremented.
    expect(await appClient.state.global.cardsActiveCount()).toEqual(activeBefore! + 1n)

    // The card really is opted into the asset: a zero-balance holding exists. This throws if
    // the opt-in inner transaction never ran.
    const holding = await algorand.asset.getAccountInformation(newCardAddress, fakeUSDC)
    expect(holding.balance).toEqual(0n)
  })

  /**
   * Happy path for the `cardAssetOptIn` guard, called directly rather than through
   * `cardCreate`. Re-opting an already-opted-in card into the same asset is a no-op axfer that
   * costs no extra MBR, so this isolates "the card box exists, therefore the guard passes"
   * from the asset bookkeeping.
   */
  test('cardAssetOptIn succeeds for an existing card', async () => {
    const result = await appClient.send.cardAssetOptIn({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
      },
      sender: owner.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Funds the card by transferring FakeUSDC straight to the card account. Cards are plain
   * asset holders, so a deposit is just a standard asset transfer from the holder's wallet
   * to the card address.
   */
  test('Deposit FakeUSDC to card', async () => {
    const { algorand } = fixture.context

    const result = await algorand.send.assetTransfer({
      sender: user.addr,
      receiver: newCardAddress,
      assetId: fakeUSDC,
      amount: 10_000_000n,
    })

    expect(result.confirmation.poolError).toBeDefined()
  })

  /**
   * `cardDebit` is gated on the `withdraw_operators` box rather than on contract ownership, so
   * with an empty registry *nobody* can debit — not the owner, who is also the partner, and not
   * the card holder. Running this before the first authorization is what proves the gate is the
   * box: an ownership-based gate would let this call through and drain the card.
   */
  test('cardDebit fails before any withdraw operator is authorized', async () => {
    const nextNonce = await appClient.send.getNextCardNonce({
      args: { card: newCardAddress },
    })

    await expect(
      appClient.send.cardDebit({
        args: {
          cardOwner: user.addr.toString(),
          card: newCardAddress,
          asset: fakeUSDC,
          amount: 1_000_000,
          nonce: nextNonce.return!,
          ref: 'Test Transaction REF-UNAUTHORIZED',
        },
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('SENDER_NOT_ALLOWED')
  })

  /**
   * The owner authorizes a dedicated debit-processing account. The box value is a marker (1) —
   * only its presence matters — and creating it locks the box MBR out of the app account's
   * balance, which the assertion on `minBalance` pins down so the release on removal can be
   * checked against it later.
   */
  test('Authorize a withdraw operator', async () => {
    const { algorand } = fixture.context

    const before = await algorand.account.getInformation(appClient.appAddress)

    const result = await appClient.send.addWithdrawOperator({
      args: { operator: withdrawOperator.addr.toString() },
    })
    expect(result.confirmation.poolError).toBe('')

    const operators = await appClient.state.box.withdrawOperators.getMap()
    expect(operators.get(withdrawOperator.addr.toString())).toEqual(1n)

    const after = await algorand.account.getInformation(appClient.appAddress)
    expect(after.minBalance.microAlgos - before.minBalance.microAlgos).toEqual(WITHDRAW_OPERATOR_BOX_MBR)
  })

  /**
   * Authorization is per-account, not a blanket switch: with one operator registered, an
   * account outside the registry is still refused. Guards against a box-existence check that
   * accidentally passes for any key (e.g. reading a default value instead of `.exists`).
   */
  test('cardDebit fails for an account outside the operator registry', async () => {
    const nextNonce = await appClient.send.getNextCardNonce({
      args: { card: newCardAddress },
    })

    await expect(
      appClient.send.cardDebit({
        args: {
          cardOwner: user.addr.toString(),
          card: newCardAddress,
          asset: fakeUSDC,
          amount: 1_000_000,
          nonce: nextNonce.return!,
          ref: 'Test Transaction REF-NOT-OPERATOR',
        },
        sender: user2.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('SENDER_NOT_ALLOWED')
  })

  /**
   * Simulates the core spend flow: the user has spent on their card, and the authorized
   * withdraw operator debits the card for the matching FakeUSDC amount. The current nonce is
   * fetched first and passed in for replay protection; the ref carries the off-chain
   * transaction identifier. The sender holds no privileged role beyond its operator box, so a
   * success here also proves the grant works without ownership or partnership.
   */
  test('User spends, withdraw operator debits', async () => {
    const nextNonce = await appClient.send.getNextCardNonce({
      args: { card: newCardAddress },
    })

    const result = await appClient.send.cardDebit({
      args: {
        cardOwner: user.addr.toString(),
        card: newCardAddress,
        asset: fakeUSDC,
        amount: 5_000_000,
        nonce: nextNonce.return!,
        ref: 'Test Transaction REF-1234567890',
      },
      sender: withdrawOperator.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBeDefined()
  })

  /**
   * Negative case for the card-ownership guard in `cardDebit`: passing a `cardOwner` that does
   * not match the card's stored owner reverts with OWNER_INVALID. This is the check that
   * prevents an AutoDraw group from funding and debiting a card the delegating account does not
   * own. Sent by the authorized operator so the call gets past `onlyWithdrawOperator` and
   * actually reaches this assert.
   */
  test('cardDebit fails when cardOwner does not own the card', async () => {
    const nextNonce = await appClient.send.getNextCardNonce({
      args: { card: newCardAddress },
    })

    await expect(
      appClient.send.cardDebit({
        args: {
          cardOwner: user2.addr.toString(),
          card: newCardAddress,
          asset: fakeUSDC,
          amount: 1_000_000,
          nonce: nextNonce.return!,
          ref: 'Test Transaction REF-OWNER',
        },
        sender: withdrawOperator.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('OWNER_INVALID')
  })

  /**
   * Reads back the card's stored data and asserts the owner, address, and nonce. The nonce
   * is expected to be 1 because the single debit above incremented it, proving replay
   * protection state advanced.
   */
  test('Get CardData', async () => {
    const result = await appClient.send.getCardData({
      args: { card: newCardAddress },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })

    expect(result.return?.owner).toBe(user.addr.toString())
    expect(result.return?.address).toBe(newCardAddress)
    expect(result.return?.nonce).toEqual(BigInt(1))
  })

  /**
   * Upgrades the Main contract program in place via the owner-only update path. Confirms
   * the contract can be patched without redeploying or losing existing card/global state.
   */
  test('Update Contract', async () => {
    const result = await appClient.send.update.update({
      args: [],
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Negative case for the card-existence guard in `cardRecover`. Without it the owner could
   * write an owner into a box for an address that was never a card, conjuring a card record
   * with a zero `address` field and no matching on-chain account, and silently corrupting the
   * active-card accounting that `destroy` relies on.
   */
  test('cardRecover fails for an unknown card', async () => {
    await expect(
      appClient.send.cardRecover({
        args: {
          card: circle.addr.toString(),
          newCardHolder: user2.addr.toString(),
        },
        staticFee: AlgoAmount.MicroAlgos(1_000),
      }),
    ).rejects.toThrow('CARD_NOT_FOUND')
  })

  /**
   * Setup for the recovery cleanup below: the outgoing holder leaves a pending withdrawal
   * request against the card. This is the realistic shape of a recovery — a user requests a
   * withdrawal, then loses access to the wallet that made the request.
   */
  test('Recovery setup: outgoing holder leaves a pending withdrawal request', async () => {
    const result = await appClient.send.withdrawalRequest({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
        amount: 1_000_000,
      },
      sender: user.addr,
    })

    expect(result.return?.card).toBe(newCardAddress)

    const boxes = await appClient.state.box.withdrawals.getMap()
    expect(boxes.has(user.addr.toString())).toBe(true)
  })

  /**
   * Owner-driven account recovery: reassigns an existing card to a new card holder. Used
   * when a user loses access to their wallet but should retain control of the card's funds.
   *
   * The pending request left by the previous holder must not survive the hand-over. Its box is
   * keyed by the *requesting account*, so after the owner changes neither party can reach it:
   * `withdraw` and `withdrawalCancel` both go through `onlyCardOwner`, which rejects the old
   * holder once the card is reassigned, and the new holder cannot address a box keyed by someone
   * else. Left in place it is a
   * permanently orphaned box with its MBR locked away, so `cardRecover` clears it.
   */
  test('Recover Card', async () => {
    const result = await appClient.send.cardRecover({
      args: {
        card: newCardAddress,
        newCardHolder: user2.addr.toString(),
      },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })

    expect(result.confirmation.poolError).toBe('')

    // Ownership moved.
    const cardData = await appClient.send.getCardData({
      args: { card: newCardAddress },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(cardData.return?.owner).toBe(user2.addr.toString())

    // The outgoing holder's request box is gone.
    const boxes = await appClient.state.box.withdrawals.getMap()
    expect(boxes.has(user.addr.toString())).toBe(false)

    // CardRecovered was emitted, carrying card / old owner / new owner. Matched on the payload
    // rather than the ARC-28 selector so the assertion does not depend on re-deriving the hash.
    const payload = Buffer.concat([
      algosdk.decodeAddress(newCardAddress).publicKey,
      user.addr.publicKey,
      user2.addr.publicKey,
    ])
    const emitted = (result.confirmation.logs ?? []).some((log) => Buffer.from(log).subarray(4).equals(payload))
    expect(emitted).toBe(true)
  })

  /**
   * The (newly recovered) card holder initiates a withdrawal request. This records the
   * pending request on-chain; with the timeout at 0 it can be completed immediately in the
   * next test.
   */
  test('User creates withdrawal request', async () => {
    const result = await appClient.send.withdrawalRequest({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
        amount: 3_000_000,
      },
      sender: user2.addr,
    })

    expect(result.return).toBeDefined()

    withdrawalRequest = result.return!
  })

  /**
   * Completes the pending withdrawal. Because the timeout is 0, the request is immediately
   * eligible and funds move from the card to the holder, closing the happy-path withdrawal
   * lifecycle.
   */
  test('Complete withdrawal request', async () => {
    const result = await appClient.send.withdraw({
      args: {
        card: newCardAddress,
        amount: withdrawalRequest.amount,
      },
      sender: user2.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Raises the withdrawal timeout to a non-zero value (10 seconds) so the following tests
   * can exercise the permissioned withdrawal path, which only matters when a real
   * timeout would otherwise block an immediate withdrawal.
   */
  test('Set withdrawal rounds to 10', async () => {
    // A real value would be:
    // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
    // We're using 0 seconds to allow for instant withdrawals
    const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 10 } })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Creates a fresh withdrawal request while the timeout is non-zero. This request can
   * NOT be completed via the normal `withdraw` path until the timeout elapses, setting up
   * the permissioned withdrawal scenario below.
   */
  test('User creates another withdrawal request', async () => {
    const result = await appClient.send.withdrawalRequest({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
        amount: 2_000_000,
      },
      sender: user2.addr,
    })

    expect(result.return).toBeDefined()

    withdrawalRequest = result.return!
  })

  // Permissioned Withdrawal Test
  /**
   * Demonstrates the permissioned withdrawal. The test reconstructs the exact byte
   * layout the contract hashes — card(32) + recipient(32) + asset(8) + amount(8) +
   * expiresAt(8) + nonce(8) + genesisHash(32) — SHA256-hashes it, and signs the digest with
   * the withdrawal authority key registered earlier. A valid signature lets the holder skip
   * the 10-second timeout. The genesis hash binds the signature to this specific network,
   * and expiresAt bounds how long the off-chain approval stays valid.
   */
  test('Request permissioned withdrawal', async () => {
    const { algorand } = fixture.context
    const suggestedParams = await algorand.client.algod.getTransactionParams().do()
    const genesisHash = Buffer.from(suggestedParams.genesisHash!)

    const { card: cardAddr, asset: withdrawalAsset, amount, nonce } = withdrawalRequest
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(3600)

    // Build withdrawal bytes matching the contract: card(32) + recipient(32) + asset(8) + amount(8) + expiresAt(8) + nonce(8) + genesisHash(32)
    const withdrawalBytes = Buffer.concat([
      algosdk.decodeAddress(cardAddr).publicKey,
      user2.addr.publicKey,
      algosdk.encodeUint64(withdrawalAsset),
      algosdk.encodeUint64(amount),
      algosdk.encodeUint64(expiresAt),
      algosdk.encodeUint64(nonce),
      genesisHash,
    ])

    // SHA256 hash the bytes, then sign with ed25519
    const withdrawalHash = createHash('sha256').update(withdrawalBytes).digest()
    const sig = ed25519SignDetached(withdrawalHash, withdrawalAcc.sk)

    const result = await appClient.send.withdrawPermissioned({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
        amount,
        expiresAt,
        nonce,
        signature: sig,
      },
      sender: user2.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000 + 3_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * The card holder opts the card out of FakeUSDC. An ASA opt-out is required before the
   * card account can be closed, since Algorand forbids closing an account still opted into
   * an asset.
   */
  test('Disable FakeUSDC for card', async () => {
    const result = await appClient.send.cardDisableAsset({
      args: {
        card: newCardAddress,
        asset: fakeUSDC,
      },
      sender: user2.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Closes the asset-free card and reclaims its minimum balance, completing the full
   * lifecycle (create → fund → debit → recover → withdraw → disable asset → close) for the
   * primary FakeUSDC card.
   */
  test('Close card', async () => {
    const result = await appClient.send.cardClose({
      args: { card: newCardAddress },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  // ========== Killswitch unit tests ==========

  /**
   * Test setup for the Killswitch suite: a card owned by `user` must exist before that user
   * can enable delegation, because `enable` checks card ownership. The created address is
   * reused as the AutoDraw card in the integration tests further down.
   */
  test('Killswitch: create card for user (required to enable delegation)', async () => {
    const result = await appClient.send.cardCreate({
      args: {
        cardOwner: user.addr.toString(),
        asset: fakeUSDC,
      },
      sender: owner.addr,
      staticFee: AlgoAmount.MicroAlgos(5_000),
    })
    expect(result.return).toBeDefined()

    autoDrawCardAddress = result.return!
  })

  /**
   * The card owner enables delegation of FakeUSDC, writing a per-(account, asset) box
   * switch that later authorizes automated draws. This is the opt-in step a user takes to
   * allow AutoDraw to pull that asset on their behalf; the card address only proves card
   * ownership.
   */
  test('Killswitch: enable user', async () => {
    const result = await ksClient.send.enable({
      args: { card: autoDrawCardAddress, asset: fakeUSDC },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Negative case: a non-owner cannot enable delegation using someone else's card as
   * ownership proof. Enforces that only the card owner can opt into the killswitch,
   * reverting with NOT_CARD_OWNER otherwise.
   */
  test('Killswitch: enable fails for account that does not own the card', async () => {
    await expect(
      ksClient.send.enable({
        args: { card: autoDrawCardAddress, asset: fakeUSDC },
        sender: user2.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('NOT_CARD_OWNER')
  })

  /**
   * Happy path for the killswitch gate: an enabled user passes `authorize` for the enabled
   * asset, the check the AutoDraw group relies on to confirm the user still consents to
   * automated debits.
   */
  test('Killswitch: authorize enabled user succeeds', async () => {
    const result = await ksClient.send.authorize({
      args: { account: user.addr.toString(), asset: fakeUSDC },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Delegation is scoped per asset: enabling FakeUSDC does not authorize draws of any
   * other asset, so `authorize` for a different asset id is refused.
   */
  test('Killswitch: authorize enabled user for another asset fails with REFUSED', async () => {
    await expect(
      ksClient.send.authorize({ args: { account: user.addr.toString(), asset: fakeUSDC + 1n } }),
    ).rejects.toThrow('REFUSED')
  })

  /**
   * The killswitch in action: once a user calls `kill` for the asset, their consent is
   * revoked and `authorize` reverts with REFUSED. This is the emergency off-switch that
   * lets a user instantly stop any further automated draws.
   */
  test('Killswitch: user kills their delegation — authorize fails with REFUSED', async () => {
    await ksClient.send.kill({ args: { asset: fakeUSDC }, sender: user.addr })

    await expect(ksClient.send.authorize({ args: { account: user.addr.toString(), asset: fakeUSDC } })).rejects.toThrow(
      'REFUSED',
    )
  })

  /**
   * Confirms the kill is reversible: a user can re-enable the asset after killing and
   * `authorize` succeeds again, so the off-switch is a pause rather than a permanent
   * lockout.
   */
  test('Killswitch: user re-enables themselves — authorize succeeds', async () => {
    await ksClient.send.enable({
      args: { card: autoDrawCardAddress, asset: fakeUSDC },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    const result = await ksClient.send.authorize({
      args: { account: user.addr.toString(), asset: fakeUSDC },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Idempotency guard: enabling an (account, asset) pair that is already enabled reverts
   * with ALREADY_ENABLED, preventing duplicate box state or double-charged MBR.
   */
  test('Killswitch: enabling again fails with ALREADY_ENABLED', async () => {
    await expect(
      ksClient.send.enable({
        args: { card: autoDrawCardAddress, asset: fakeUSDC },
        sender: user.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('ALREADY_ENABLED')
  })

  /**
   * Default-deny behavior: an account that never opted in is refused by `authorize`. Only
   * users who explicitly enabled delegation can be authorized.
   */
  test('Killswitch: authorize non-enabled account fails with REFUSED', async () => {
    await expect(
      ksClient.send.authorize({ args: { account: user2.addr.toString(), asset: fakeUSDC } }),
    ).rejects.toThrow('REFUSED')
  })

  /**
   * Global circuit breaker: while the contract is paused, even a properly enabled user is
   * refused. This lets Partner halt all automated draws system-wide in an incident, on top of
   * the per-user killswitch.
   */
  test('Killswitch: pause contract — authorize fails', async () => {
    await ksClient.send.pause({ args: [] })

    await expect(
      ksClient.send.authorize({ args: { account: user.addr.toString(), asset: fakeUSDC } }),
    ).rejects.toThrow()
  })

  /**
   * Confirms the global pause is reversible: after `unpause`, enabled users are authorized
   * again and normal operation resumes.
   */
  test('Killswitch: unpause contract — authorize succeeds', async () => {
    await ksClient.send.unpause({ args: [] })

    const result = await ksClient.send.authorize({
      args: { account: user.addr.toString(), asset: fakeUSDC },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(result.confirmation.poolError).toBe('')
  })

  // ========== AutoDraw integration tests ==========

  /**
   * Builds the AutoDraw delegated logic signature. The TEAL template is hydrated with the
   * concrete killswitch app id, main app id, and genesis hash, compiled, then signed by
   * the user so it acts as a delegated approval. The lsig does not pin an asset id itself —
   * the transferred asset is bound to the per-(account, asset) killswitch delegation via
   * `authorize`'s asset argument, which is what makes delegating it to Partner safe.
   */
  test('AutoDraw: compile lsig and user signs for delegation', async () => {
    const { algorand } = fixture.context
    const algod = algorand.client.algod

    const suggestedParams = await algod.getTransactionParams().do()
    const genesisHashHex = Buffer.from(suggestedParams.genesisHash!).toString('hex')

    const tealTemplate = readFileSync(join(testDir, '../artifacts/auto_draw/AutoDraw.teal'), 'utf-8')
    const teal = tealTemplate
      .replace('TMPL_KILLSWITCH_APP', String(ksClient.appId))
      .replace('TMPL_MAIN_APP', String(appClient.appId))
      .replace('TMPL_GENESIS_HASH', `0x${genesisHashHex}`)

    const compiled = await algod.compile(teal).do()
    const program = Buffer.from(compiled.result, 'base64')

    autoDrawLsig = new algosdk.LogicSigAccount(program)
    autoDrawLsig.sign(user.sk)

    expect(autoDrawLsig.lsig.sig).toBeDefined()
  })

  /**
   * The core AutoDraw integration: a single atomic group [axfer, authorize, cardDebit]
   * debits a card that starts at zero balance. Transaction [0] uses the delegated lsig to
   * pull funds from the user's wallet into the card (fee=0), [1] checks the killswitch
   * consent, and [2] debits the now-funded card. Bundling them atomically means the card is
   * funded just-in-time and the whole draw fails together if any guard rejects.
   */
  test('AutoDraw: group debit succeeds from zero-balance card', async () => {
    const { algorand } = fixture.context
    const algod = algorand.client.algod

    const nonceResult = await appClient.send.getNextCardNonce({
      args: { card: autoDrawCardAddress },
    })

    const suggestedParams = await algod.getTransactionParams().do()
    const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: user.addr.toString(),
      receiver: autoDrawCardAddress,
      assetIndex: Number(fakeUSDC),
      amount: AUTO_DRAW_DEBIT_AMOUNT,
      suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
    })

    const composer = algorand.newGroup()
    // [0] AutoDraw lsig axfer: user's main account → card (fee=0)
    composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig))
    // [1] Killswitch.authorize: validates user's per-asset switch and paused state
    composer.addAppCallMethodCall(
      await ksClient.params.authorize({
        args: { account: user.addr.toString(), asset: fakeUSDC },
        staticFee: AlgoAmount.MicroAlgos(1_000),
      }),
    )
    // [2] cardDebit: inner txn card→Main sees the card funded by [0]
    composer.addAppCallMethodCall(
      await appClient.params.cardDebit({
        args: {
          card: autoDrawCardAddress,
          asset: fakeUSDC,
          amount: AUTO_DRAW_DEBIT_AMOUNT,
          cardOwner: user.addr.toString(),
          nonce: nonceResult.return!,
          ref: 'AutoDraw Test REF-001',
        },
        sender: withdrawOperator.addr,
        staticFee: AlgoAmount.MicroAlgos(3_000),
      }),
    )

    const result = await composer.send()
    expect(result.confirmations.every((c) => c.poolError === '')).toBe(true)
  })

  /**
   * Confirms the delegated debit advanced replay-protection state: the card nonce reads 1
   * after the single successful AutoDraw group.
   */
  test('AutoDraw: card nonce incremented after debit', async () => {
    const result = await appClient.send.getCardData({
      args: { card: autoDrawCardAddress },
    })
    expect(result.return?.nonce).toEqual(1n)
  })

  /**
   * Security check: if the user has killed their delegation, the whole AutoDraw group is
   * rejected with REFUSED at the `authorize` step, so no funds move even though the lsig and
   * debit are otherwise valid. Re-enables the user afterward to restore state for following
   * tests.
   */
  test('AutoDraw: group fails when user has disabled themselves', async () => {
    const { algorand } = fixture.context
    const algod = algorand.client.algod

    await ksClient.send.kill({ args: { asset: fakeUSDC }, sender: user.addr })

    const nonceResult = await appClient.send.getNextCardNonce({
      args: { card: autoDrawCardAddress },
    })

    const suggestedParams = await algod.getTransactionParams().do()
    const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: user.addr.toString(),
      receiver: autoDrawCardAddress,
      assetIndex: Number(fakeUSDC),
      amount: AUTO_DRAW_DEBIT_AMOUNT,
      suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
    })

    const composer = algorand.newGroup()
    composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig))
    composer.addAppCallMethodCall(
      await ksClient.params.authorize({
        args: { account: user.addr.toString(), asset: fakeUSDC },
        staticFee: AlgoAmount.MicroAlgos(1_000),
      }),
    )
    composer.addAppCallMethodCall(
      await appClient.params.cardDebit({
        args: {
          cardOwner: user.addr.toString(),
          card: autoDrawCardAddress,
          asset: fakeUSDC,
          amount: AUTO_DRAW_DEBIT_AMOUNT,
          nonce: nonceResult.return!,
          ref: 'AutoDraw Test REF-002',
        },
        sender: withdrawOperator.addr,
        staticFee: AlgoAmount.MicroAlgos(3_000),
      }),
    )

    await expect(composer.send()).rejects.toThrow('REFUSED')

    await ksClient.send.enable({
      args: { card: autoDrawCardAddress, asset: fakeUSDC },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
  })

  /**
   * System-wide guard: while the Killswitch contract is globally paused, the AutoDraw group
   * is rejected at `authorize` regardless of individual user consent. Unpauses afterward to
   * leave the contract in a clean state.
   */
  test('AutoDraw: group fails when Killswitch is paused', async () => {
    const { algorand } = fixture.context
    const algod = algorand.client.algod

    await ksClient.send.pause({ args: [] })

    const nonceResult = await appClient.send.getNextCardNonce({
      args: { card: autoDrawCardAddress },
    })

    const suggestedParams = await algod.getTransactionParams().do()
    const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: user.addr.toString(),
      receiver: autoDrawCardAddress,
      assetIndex: Number(fakeUSDC),
      amount: AUTO_DRAW_DEBIT_AMOUNT,
      suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
    })

    const composer = algorand.newGroup()
    composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig))
    composer.addAppCallMethodCall(
      await ksClient.params.authorize({
        args: { account: user.addr.toString(), asset: fakeUSDC },
        staticFee: AlgoAmount.MicroAlgos(1_000),
      }),
    )
    composer.addAppCallMethodCall(
      await appClient.params.cardDebit({
        args: {
          cardOwner: user.addr.toString(),
          card: autoDrawCardAddress,
          asset: fakeUSDC,
          amount: AUTO_DRAW_DEBIT_AMOUNT,
          nonce: nonceResult.return!,
          ref: 'AutoDraw Test REF-003',
        },
        sender: withdrawOperator.addr,
        staticFee: AlgoAmount.MicroAlgos(3_000),
      }),
    )

    await expect(composer.send()).rejects.toThrow()

    await ksClient.send.unpause({ args: [] })
  })

  // ========== Withdraw operator revocation ==========

  /**
   * Revocation is as privileged as authorization: an operator that could revoke itself — or
   * revoke a peer — could disrupt debit processing, so `removeWithdrawOperator` is owner-only.
   * The operator attempts to remove itself and is rejected, leaving its box intact.
   */
  test('removeWithdrawOperator fails for non-owner', async () => {
    await expect(
      appClient.send.removeWithdrawOperator({
        args: { operator: withdrawOperator.addr.toString() },
        sender: withdrawOperator.addr,
      }),
    ).rejects.toThrow()

    expect((await appClient.state.box.withdrawOperators.getMap()).has(withdrawOperator.addr.toString())).toBe(true)
  })

  /**
   * The owner revokes the operator: the box is deleted, its MBR returns to the app account's
   * free balance, and a debit from the revoked account is refused with SENDER_NOT_ALLOWED. The
   * probe debits 0 so the only thing that can reject it is the operator gate.
   */
  test('removeWithdrawOperator revokes debit access and releases the box MBR', async () => {
    const { algorand } = fixture.context

    const before = await algorand.account.getInformation(appClient.appAddress)

    const result = await appClient.send.removeWithdrawOperator({
      args: { operator: withdrawOperator.addr.toString() },
    })
    expect(result.confirmation.poolError).toBe('')

    expect((await appClient.state.box.withdrawOperators.getMap()).has(withdrawOperator.addr.toString())).toBe(false)

    const after = await algorand.account.getInformation(appClient.appAddress)
    expect(before.minBalance.microAlgos - after.minBalance.microAlgos).toEqual(WITHDRAW_OPERATOR_BOX_MBR)

    const nonceResult = await appClient.send.getNextCardNonce({
      args: { card: autoDrawCardAddress },
    })

    await expect(
      appClient.send.cardDebit({
        args: {
          cardOwner: user.addr.toString(),
          card: autoDrawCardAddress,
          asset: fakeUSDC,
          amount: 0,
          nonce: nonceResult.return!,
          ref: 'AutoDraw Test REF-REVOKED',
        },
        sender: withdrawOperator.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('SENDER_NOT_ALLOWED')
  })

  /**
   * Positive control for the revocation above, and proof the registry is re-grantable: the
   * owner authorizes the same account again and the identical zero-amount debit succeeds, so
   * the rejection above can only have come from the missing operator box. The operator is
   * revoked again at the end, both to leave the registry empty for `destroy` and to confirm
   * the add/remove cycle is repeatable on the same key.
   */
  test('Re-authorizing a revoked operator restores debit access', async () => {
    await appClient.send.addWithdrawOperator({
      args: { operator: withdrawOperator.addr.toString() },
    })

    const nonceResult = await appClient.send.getNextCardNonce({
      args: { card: autoDrawCardAddress },
    })

    const debit = await appClient.send.cardDebit({
      args: {
        cardOwner: user.addr.toString(),
        card: autoDrawCardAddress,
        asset: fakeUSDC,
        amount: 0,
        nonce: nonceResult.return!,
        ref: 'AutoDraw Test REF-REAUTHORIZED',
      },
      sender: withdrawOperator.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    expect(debit.confirmation.poolError).toBe('')

    await appClient.send.removeWithdrawOperator({
      args: { operator: withdrawOperator.addr.toString() },
    })
    expect((await appClient.state.box.withdrawOperators.getMap()).has(withdrawOperator.addr.toString())).toBe(false)
  })

  /**
   * Opts the AutoDraw card out of FakeUSDC, the required precondition before the card
   * account can be closed.
   */
  test('AutoDraw: disable FakeUSDC for card', async () => {
    const result = await appClient.send.cardDisableAsset({
      args: {
        card: autoDrawCardAddress,
        asset: fakeUSDC,
      },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  /**
   * Closes the AutoDraw card and reclaims its minimum balance, tearing down the integration
   * fixture.
   */
  test('AutoDraw: close card', async () => {
    const result = await appClient.send.cardClose({
      args: { card: autoDrawCardAddress },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })

  // ========== Withdrawal card-binding tests ==========

  /**
   * Setup for the CARD_MISMATCH guard. A withdrawal request lives in a box keyed by the
   * *requesting account*, not by the card, so a holder who owns more than one card has a single
   * request slot covering all of them. Proving the card binding therefore needs two cards owned
   * by the same holder, both funded: if both hold the full requested amount, the only thing
   * standing between a request against card A and a drain of card B is the assert itself.
   *
   * The timeout goes back to 0 for the same reason — otherwise `withdraw` would revert on
   * WITHDRAWAL_TIME_INVALID and the test could pass without the card check ever running.
   */
  test('Withdrawal binding: set up two funded cards for one holder', async () => {
    const { algorand } = fixture.context

    await appClient.send.setWithdrawalTimeout({ args: { seconds: 0 } })

    const [a, b] = [
      await appClient.send.cardCreate({
        args: { cardOwner: user.addr.toString(), asset: fakeUSDC },
        sender: owner.addr,
        staticFee: AlgoAmount.MicroAlgos(5_000),
      }),
      await appClient.send.cardCreate({
        args: { cardOwner: user.addr.toString(), asset: fakeUSDC },
        sender: owner.addr,
        staticFee: AlgoAmount.MicroAlgos(5_000),
      }),
    ]

    expect(a.return).toBeDefined()
    expect(b.return).toBeDefined()

    bindingCardA = a.return!
    bindingCardB = b.return!
    expect(bindingCardA).not.toBe(bindingCardB)

    // Fund both cards identically so a wrong-card withdrawal would otherwise succeed.
    for (const card of [bindingCardA, bindingCardB]) {
      await algorand.send.assetTransfer({
        sender: user.addr,
        receiver: card,
        assetId: fakeUSDC,
        amount: BINDING_FUND_AMOUNT,
      })
    }

    const [holdingA, holdingB] = await Promise.all([
      algorand.asset.getAccountInformation(bindingCardA, fakeUSDC),
      algorand.asset.getAccountInformation(bindingCardB, fakeUSDC),
    ])
    expect(holdingA.balance).toEqual(BINDING_FUND_AMOUNT)
    expect(holdingB.balance).toEqual(BINDING_FUND_AMOUNT)
  })

  /**
   * The holder requests a withdrawal against the first card. The returned request records
   * `card`, which is the field `withdraw` later checks the passed-in card against.
   */
  test('Withdrawal binding: request a withdrawal against the first card', async () => {
    const result = await appClient.send.withdrawalRequest({
      args: {
        card: bindingCardA,
        asset: fakeUSDC,
        amount: BINDING_FUND_AMOUNT,
      },
      sender: user.addr,
    })

    expect(result.return).toBeDefined()
    expect(result.return?.card).toBe(bindingCardA)

    bindingRequest = result.return!
  })

  /**
   * The CARD_MISMATCH guard: the holder owns both cards and has a valid, matured request, but
   * passes the *other* card to `withdraw`. Without the assert the request against card A would
   * authorize draining card B — every preceding check passes, since the holder owns card B, the
   * amount is within the request, and both cards are at withdrawal nonce 0. Card B's balance is
   * re-checked afterward to prove nothing moved.
   */
  test('Withdrawal binding: withdrawing against a different card fails with CARD_MISMATCH', async () => {
    const { algorand } = fixture.context

    await expect(
      appClient.send.withdraw({
        args: {
          card: bindingCardB,
          amount: bindingRequest.amount,
        },
        sender: user.addr,
        staticFee: AlgoAmount.MicroAlgos(2_000),
      }),
    ).rejects.toThrow('CARD_MISMATCH')

    const holdingB = await algorand.asset.getAccountInformation(bindingCardB, fakeUSDC)
    expect(holdingB.balance).toEqual(BINDING_FUND_AMOUNT)
  })

  /**
   * Positive control for the guard: the same request, replayed against the card it was actually
   * created for, succeeds and drains only that card. This is what keeps the test above honest —
   * it fails on a thrown CARD_MISMATCH, not on a request that was unusable to begin with.
   */
  test('Withdrawal binding: withdrawing against the requested card succeeds', async () => {
    const { algorand } = fixture.context

    const result = await appClient.send.withdraw({
      args: {
        card: bindingCardA,
        amount: bindingRequest.amount,
      },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    expect(result.confirmation.poolError).toBe('')

    const [holdingA, holdingB] = await Promise.all([
      algorand.asset.getAccountInformation(bindingCardA, fakeUSDC),
      algorand.asset.getAccountInformation(bindingCardB, fakeUSDC),
    ])
    expect(holdingA.balance).toEqual(0n)
    expect(holdingB.balance).toEqual(BINDING_FUND_AMOUNT)

    // The successful withdrawal advanced the card's own withdrawal nonce.
    const cardData = await appClient.send.getCardData({
      args: { card: bindingCardA },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
    expect(cardData.return?.withdrawalNonce).toEqual(1n)
  })

  /**
   * The other half of the recovery cleanup: `cardRecover` must clear only a request that targets
   * the card being recovered. Because the request box is keyed by the holder rather than by the
   * card, a holder with two cards has one slot, and a blanket delete on recovery of card A would
   * silently destroy a perfectly valid request against card B.
   *
   * Card A is handed to `user2` and immediately handed back, so the rest of the teardown can
   * still act as `user`.
   */
  test('Withdrawal binding: cardRecover leaves a request against another card alone', async () => {
    const pending = await appClient.send.withdrawalRequest({
      args: {
        card: bindingCardB,
        asset: fakeUSDC,
        amount: BINDING_FUND_AMOUNT,
      },
      sender: user.addr,
    })
    expect(pending.return?.card).toBe(bindingCardB)

    await appClient.send.cardRecover({
      args: { card: bindingCardA, newCardHolder: user2.addr.toString() },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })

    // The request survived the recovery of the unrelated card, unchanged.
    const boxes = await appClient.state.box.withdrawals.getMap()
    expect(boxes.get(user.addr.toString())?.card).toBe(bindingCardB)
    expect(boxes.get(user.addr.toString())?.amount).toEqual(BINDING_FUND_AMOUNT)

    // Hand card A back so the teardown below can close it as its holder.
    await appClient.send.cardRecover({
      args: { card: bindingCardA, newCardHolder: user.addr.toString() },
      staticFee: AlgoAmount.MicroAlgos(1_000),
    })
  })

  /**
   * `cardClose` performs the same cleanup for the same reason: once the card box is deleted, a
   * request pointing at it can never be completed or cancelled, because both paths call
   * `onlyCardOwner`, which fails with CARD_NOT_FOUND. The request is created after the card
   * is drained (amount 0, which is all the balance allows) purely to have a live box at close
   * time.
   */
  test('Withdrawal binding: cardClose clears a pending request for the closed card', async () => {
    // Drain card B using the request left pending by the previous test.
    await appClient.send.withdraw({
      args: { card: bindingCardB, amount: BINDING_FUND_AMOUNT },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    await appClient.send.withdrawalRequest({
      args: { card: bindingCardB, asset: fakeUSDC, amount: 0 },
      sender: user.addr,
    })
    expect((await appClient.state.box.withdrawals.getMap()).has(user.addr.toString())).toBe(true)

    await appClient.send.cardDisableAsset({
      args: { card: bindingCardB, asset: fakeUSDC },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    const closed = await appClient.send.cardClose({
      args: { card: bindingCardB },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    expect(closed.confirmation.poolError).toBe('')

    expect((await appClient.state.box.withdrawals.getMap()).has(user.addr.toString())).toBe(false)
  })

  /**
   * Teardown for the remaining binding card. Card B was already drained and closed above, so only
   * card A is left — its asset must be closed out before the account itself can be closed.
   */
  test('Withdrawal binding: close the remaining card', async () => {
    await appClient.send.cardDisableAsset({
      args: { card: bindingCardA, asset: fakeUSDC },
      sender: user.addr,
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    const closed = await appClient.send.cardClose({
      args: { card: bindingCardA },
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })
    expect(closed.confirmation.poolError).toBe('')

    expect(await appClient.state.global.cardsActiveCount()).toEqual(0n)
  })

  /**
   * Final lifecycle step: the owner destroys the Main contract and reclaims any remaining
   * balance, verifying the app can be cleanly deleted once all cards are closed.
   */
  test('Destroy Contract', async () => {
    const result = await appClient.send.delete.destroy({
      args: [],
      staticFee: AlgoAmount.MicroAlgos(2_000),
    })

    expect(result.confirmation.poolError).toBe('')
  })
})
