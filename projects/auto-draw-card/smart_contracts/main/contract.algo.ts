/*
 * MIT License
 *
 * Copyright (c) 2026 Algorand Foundation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  abimethod,
  Account,
  Application,
  arc4,
  assert,
  Asset,
  BoxMap,
  bytes,
  clone,
  compile,
  Contract,
  emit,
  ensureBudget,
  Global,
  GlobalState,
  itxn,
  OnCompleteAction,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { classes } from 'polytype'
import type { Killswitch } from '../killswitch/contract.algo'
import { Ownable } from '../roles/ownable.algo'
import { Pausable } from '../roles/pausable.algo'
import { Recoverable } from '../roles/recoverable.algo'

// CardData
type CardData = {
  owner: Account
  address: Account
  nonce: uint64
  withdrawalNonce: uint64
}

const WithdrawalTypeApproved = 'approved'
const WithdrawalTypePermissionLess = 'permissionless'

// ========== Event Types ==========
type CardCreated = {
  cardOwner: Account
  card: Account
}

type CardAssetEnabled = {
  card: Account
  asset: Asset
}

type CardAssetDisabled = {
  card: Account
  asset: Asset
}

type CardRecovered = {
  card: Account
  oldCardOwner: Account
  newCardOwner: Account
}

type Debit = {
  card: Account
  asset: Asset
  amount: uint64
  nonce: uint64
  reference: string
}

type WithdrawalRequest = {
  card: Account
  recipient: Account
  asset: Asset
  amount: uint64
  createdAt: uint64
  nonce: uint64
}

type WithdrawalRequestCancelled = {
  card: Account
  recipient: Account
  asset: Asset
  amount: uint64
  createdAt: uint64
  nonce: uint64
}

type Withdrawal = {
  card: Account
  recipient: Account
  asset: Asset
  amount: uint64
  createdAt: uint64
  expiresAt: uint64
  nonce: uint64
  type: string
}

type PermissionedWithdrawal = {
  card: Account
  recipient: Account
  asset: Asset
  amount: uint64
  expiresAt: uint64
  nonce: uint64
  genesisHash: bytes<32>
}

type TreasuryAssetEnabled = {
  treasury: Account
  asset: Asset
}

type TreasuryAssetDisabled = {
  treasury: Account
  asset: Asset
}

// One event per refund batch, not per recipient: the individual recipient/amount pairs are
// already on chain in the call's `transfers` argument and the inner transfers themselves.
type Refund = {
  treasury: Account
  asset: Asset
  count: uint64
  total: uint64
  expiresAt: uint64
  nonce: uint64
}

type RefundTransfer = {
  recipient: Account
  amount: uint64
}

type RefundBatch = {
  treasury: Account
  asset: Asset
  expiresAt: uint64
  nonce: uint64
  genesisHash: bytes<32>
  transfers: RefundTransfer[]
}

type Treasury = {
  address: Account
  nonce: uint64
}

// Maximum recipients per refund batch. Bounded by the 2048-byte total app-argument limit, not
// by references or budgets: the call's arguments cost 94 + 40*N bytes, so 48 is the largest
// batch the protocol accepts in one call. Resource availability is the caller's to provide via
// access lists (2*N + 4 entries group-wide, 16 per app call — see cardRefund). Asserting the
// cap turns an obscure protocol rejection into a clear one, and stops a signature being minted
// for a batch that could never execute.
const MaxRefundTransfers = 48

class ControlledAddress extends Contract {
  /**
   * Create a new account, rekeying it to the caller application address
   * @returns New account address
   */
  @abimethod({ allowActions: ['DeleteApplication'], onCreate: 'require' })
  public new(): Account {
    itxn
      .payment({
        receiver: Global.currentApplicationAddress,
        amount: 0,
        rekeyTo: Global.callerApplicationAddress,
      })
      .submit()

    return Global.currentApplicationAddress
  }
}

// ========== Trust model: off-chain invariants ==========
//
// Partner enforces ONE ACTIVE CARD PER HOLDER off-chain, at card issuance.
//
// This contract deliberately does not enforce that, and on-chain logic must stay correct when a
// holder does hold several: `cardRecover` can produce that state directly, and the CARD_MISMATCH
// guard in `withdraw` exists for exactly this case (see the withdrawal-binding tests in
// contract.e2e.spec.ts, which own two cards to prove a request against one cannot drain the other).
//
// Two consequences follow from keying state by holder rather than by card. Both are ACCEPTED
// behaviour, not defects to be re-litigated:
//
//   - A holder has a single withdrawal-request slot covering all of their cards, because
//     `withdrawals` is keyed by the requesting account (see `clearWithdrawalRequest`).
//   - Revoking a holder's AutoDraw delegation applies to every card they own, because the
//     Killswitch keys delegation by (holder, asset) (see `killDelegation`).
//
// Anything that would break under multiple cards per holder is a real bug; anything that merely
// applies holder-wide is the design.
export class Main extends classes(Ownable, Pausable, Recoverable) {
  // ========== Storage ==========
  // Cards
  public cards = BoxMap<Account, CardData>({ keyPrefix: 'cf' })

  public cards_active_count = GlobalState<uint64>({ key: 'cfac' })

  // Seconds to wait
  public withdrawal_wait_time = GlobalState<uint64>({ key: 'wwt' })

  // Permissioned withdrawal public key
  public withdrawal_pubkey = GlobalState<bytes<32>>({ key: 'pwpk' })

  // Withdrawal requests
  // Only one allowed at any given point. MBR is sponsored by the contract owner (app account).
  public withdrawals = BoxMap<Account, WithdrawalRequest>({ keyPrefix: 'wr' })

  // Partner address
  public partner_address = GlobalState<Account>({ key: 'pa' })

  // Omnibus address
  public omnibus_address = GlobalState<Account>({ key: 'oa' })

  // Authorized withdraw operators. Presence of the box (value 1) grants the
  // account permission to call cardDebit. MBR is released on removal.
  public withdraw_operators = BoxMap<Account, uint64>({ keyPrefix: 'wop' })

  // The Killswitch contract holding AutoDraw delegations. Registered by the owner after
  // deployment (the two contracts reference each other, so neither can know the other's app id
  // at create time). While unset, disabling an asset skips delegation cleanup.
  public killswitch_app = GlobalState<Application>({ key: 'ks' })

  // The treasury account refunds are paid out of
  public treasury = GlobalState<Treasury>({ key: 't' })

  // Authorized refund operators. Presence of the box (value 1) grants the account permission to
  // call cardRefund. MBR is released on removal.
  public refund_operators = BoxMap<Account, uint64>({ keyPrefix: 'rop' })

  // Ed25519 public key of the refund signer
  public refund_pubkey = GlobalState<bytes<32>>({ key: 'rpk' })

  // ========== Internal Utils ==========
  /**
   * Check if the current transaction sender is the card holder/owner
   * @param card Card address
   * @returns True if the sender is the Card Holder of the card
   */
  private isCardOwner(card: Account): boolean {
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')
    return this.cards(card).value.owner === Txn.sender
  }

  /**
   * Assert that the current transaction sender is the card holder/owner
   * @param card Card address
   */
  private onlyCardOwner(card: Account): void {
    assert(this.isCardOwner(card), 'SENDER_NOT_ALLOWED')
  }

  /**
   * Check if the current transaction sender is the partner address
   * @returns True if the sender is the partner
   */
  private isPartner(): boolean {
    return Txn.sender === this.partner_address.value
  }

  /**
   * Assert that the current transaction sender is the partner address
   */
  private onlyPartner(): void {
    assert(this.isPartner(), 'SENDER_NOT_ALLOWED')
  }

  /**
   * Assert the transaction sender is an authorized withdraw operator.
   */
  private onlyWithdrawOperator(): void {
    assert(this.withdraw_operators(Txn.sender).exists, 'SENDER_NOT_ALLOWED')
  }

  /**
   * Opt-in a card into an asset. Any shortfall in the card's minimum balance requirement is
   * topped up from the contract escrow, so the caller does not have to pre-fund the card.
   * A card already opted into the asset is rejected, since the call would do nothing.
   * Only the partner can call this function.
   * @param card Card address
   * @param asset Asset to opt-in to
   */
  public cardAssetOptIn(card: Account, asset: Asset): void {
    this.onlyPartner()
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')

    // Reject a card already holding the asset rather than repeating the opt-in: the call would
    // change nothing, and rejecting keeps it from costing anything at all.
    const [, alreadyOptedIn] = op.AssetHolding.assetBalance(card, asset)
    assert(!alreadyOptedIn, 'ASSET_ALREADY_ENABLED')

    // Opting in raises the card's MBR by one asset slot, so cover any shortfall up front from
    // the contract escrow — the opt-in itself would otherwise fail.
    const required: uint64 = card.minBalance + Global.assetOptInMinBalance
    if (card.balance < required) {
      itxn
        .payment({
          receiver: card,
          amount: required - card.balance,
        })
        .submit()
    }

    itxn
      .assetTransfer({
        sender: card,
        assetReceiver: card,
        xferAsset: asset,
        assetAmount: 0,
      })
      .submit()

    emit<CardAssetEnabled>({
      card: card,
      asset: asset,
    })
  }

  /**
   * Close a card out of an asset and sweep the Algo it no longer needs back to the contract.
   *
   * The close-out drops the card's MBR by one asset slot, so the sponsorship that funded that slot
   * would otherwise sit idle on the card. Reading the balance after the close-out inner
   * transaction picks up the reduced requirement, so the sweep also returns any other surplus the
   * card has accumulated, and always leaves the card exactly at its remaining MBR.
   *
   * @param card Card address
   * @param asset Asset to close out of
   */
  private cardAssetCloseOut(card: Account, asset: Asset): void {
    itxn
      .assetTransfer({
        sender: card,
        assetReceiver: card,
        assetCloseTo: card,
        xferAsset: asset,
        assetAmount: 0,
      })
      .submit()

    if (card.balance > card.minBalance) {
      itxn
        .payment({
          sender: card,
          receiver: Global.currentApplicationAddress,
          amount: card.balance - card.minBalance,
        })
        .submit()
    }

    emit<CardAssetDisabled>({
      card: card,
      asset: asset,
    })
  }

  /**
   * Clear the pending withdrawal request held by `owner`, but only when it targets `card`.
   *
   * The request box is keyed by the requesting account rather than by the card, so a holder with
   * several cards has a single request slot covering all of them. A request against a *different*
   * card is still perfectly valid and must be left alone.
   *
   * Once a card changes hands or is closed, the previous holder can neither complete nor cancel
   * their request — both paths go through `onlyCardOwner`, which fails — so the box would be
   * orphaned and its MBR locked away permanently. Clearing it here releases that MBR back to the
   * contract and leaves the new holder a clean slot.
   *
   * @param owner Account whose request box is being cleared
   * @param card Card the request must reference to be cleared
   */
  private clearWithdrawalRequest(owner: Account, card: Account): void {
    if (this.withdrawals(owner).exists && this.withdrawals(owner).value.card === card) {
      const withdrawal = clone(this.withdrawals(owner).value)
      this.withdrawals(owner).delete()
      emit<WithdrawalRequestCancelled>(withdrawal)
    }
  }

  /**
   * Revoke `owner`'s AutoDraw delegation for a single asset on the Killswitch contract.
   *
   * The delegation box lives in the Killswitch app, keyed by (account, asset), and must be
   * referenced by the calling transaction. Revoking is best-effort: an asset the holder never
   * enabled is a no-op rather than an error.
   *
   * Delegation is per (holder, asset) and not per card, so revoking here also stops automated
   * draws of that asset into any other card the holder still owns.
   *
   * @param owner Account whose delegation is being revoked
   * @param asset Asset to revoke delegation for
   */
  private killDelegation(owner: Account, asset: Asset): void {
    // Nothing to revoke against until the owner registers the Killswitch app.
    if (!this.killswitch_app.hasValue) {
      return
    }

    arc4.abiCall<typeof Killswitch.prototype.killFor>({
      appId: this.killswitch_app.value,
      args: [owner, asset],
    })
  }

  private withdrawFunds(
    card: Account,
    asset: Asset,
    amount: uint64,
    timestamp: uint64,
    nonce: uint64,
    withdrawalType: string,
  ): void {
    // if amount is zero, we skip the asset transfer
    if (amount > 0) {
      itxn
        .assetTransfer({
          sender: card,
          assetReceiver: Txn.sender,
          xferAsset: asset,
          assetAmount: amount,
        })
        .submit()
    }

    // Emit withdrawal event
    emit<Withdrawal>({
      card: card,
      recipient: Txn.sender,
      asset: asset,
      amount: amount,
      createdAt: withdrawalType === WithdrawalTypePermissionLess ? timestamp : 0,
      expiresAt: withdrawalType === WithdrawalTypeApproved ? timestamp : 0,
      nonce: nonce,
      type: withdrawalType,
    })

    this.cards(card).value.withdrawalNonce = nonce + 1
  }

  // ========== External Methods ==========
  /**
   * Deploy the contract, setting the owner as provided and initializing global state.
   * The refund treasury is not created here — see treasuryAssetOptIn — so its global state
   * starts unset.
   */
  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public deploy(owner: Account, omnibus: Account): Account {
    this._transferOwnership(owner)
    this.omnibus_address.value = omnibus
    this._pauser.value = Txn.sender

    // puya-ts does not auto-zero-init GlobalState, so set the counters explicitly
    // at creation time.
    this.cards_active_count.value = 0
    this.paused.value = false

    return Global.currentApplicationAddress
  }

  /**
   * Allows the owner to update the smart contract
   */
  @abimethod({ allowActions: ['UpdateApplication'] })
  public update(): void {
    this.onlyOwner()
  }

  /**
   * Destroy the smart contract, sending all Algo — including anything left on the treasury — to
   * the owner account. This can only be done if there are no active cards, and the treasury must
   * already be closed out of every asset (an account holding an ASA cannot be closed).
   */
  @abimethod({ allowActions: ['DeleteApplication'] })
  public destroy(): void {
    this.onlyOwner()

    // There must not be any active card
    assert(!this.cards_active_count.value, 'CARDS_STILL_ACTIVE')

    // The treasury is rekeyed to this app, so anything left on it must come home before the app
    // disappears — afterwards its authorizer no longer exists and the balance is stranded
    // forever. Unset treasury state means no treasury was ever created (or it was already
    // closed via treasuryClose), so there is nothing to sweep.
    if (this.treasury.hasValue) {
      itxn
        .payment({
          sender: this.treasury.value.address,
          receiver: Global.currentApplicationAddress,
          amount: 0,
          closeRemainderTo: Global.currentApplicationAddress,
        })
        .submit()
    }

    itxn
      .payment({
        receiver: Global.currentApplicationAddress,
        amount: 0,
        closeRemainderTo: this.owner(),
      })
      .submit()
  }

  // ===== Owner / Partner Methods =====
  /**
   * Set the number of seconds a withdrawal request must wait until being withdrawn
   * @param seconds New number of seconds to wait
   */
  public setWithdrawalTimeout(seconds: uint64): void {
    this.onlyOwner()

    this.withdrawal_wait_time.value = seconds
  }

  /**
   * Sets the withdrawal public key.
   * @param pubkey - The public key to set.
   */
  public setWithdrawalPubkey(pubkey: bytes<32>): void {
    this.onlyOwner()

    this.withdrawal_pubkey.value = pubkey
  }

  /**
   * Create a card. This generates a brand new account and funds the minimum balance requirement
   * from the contract (owner-sponsored). Only the partner can call this function.
   * @param cardOwner The card holder who will own/control the card
   * @param asset Asset to opt-in to. 0 = No asset opt-in
   * @returns Newly generated account used by their card
   */
  public cardCreate(cardOwner: Account, asset: Asset): Account {
    this.onlyPartner()

    const cardData: CardData = {
      owner: cardOwner,
      address: Global.zeroAddress,
      nonce: 0,
      withdrawalNonce: 0,
    }

    // Create a new account
    const compiledCard = compile(ControlledAddress)
    const cardAddr = arc4.abiCall<typeof ControlledAddress.prototype.new>({
      approvalProgram: compiledCard.approvalProgram,
      clearStateProgram: compiledCard.clearStateProgram,
      onCompletion: OnCompleteAction.DeleteApplication,
    }).returnValue

    // Update the card data with the newly generated address
    cardData.address = cardAddr

    // Fund the account with a minimum balance
    const assetMbr: uint64 = asset.id ? Global.assetOptInMinBalance : 0
    itxn
      .payment({
        receiver: cardAddr,
        amount: Global.minBalance + assetMbr,
      })
      .submit()

    // Store new card along with Card Holder
    this.cards(cardAddr).value = clone(cardData)

    // Increment active cards
    this.cards_active_count.value = this.cards_active_count.value + 1

    // Opt-in to the asset if provided
    if (asset.id) {
      this.cardAssetOptIn(cardAddr, asset)
    }

    emit<CardCreated>({
      cardOwner: cardOwner,
      card: cardAddr,
    })

    // Return the new account address
    return cardAddr
  }

  /**
   * Close account. This permanently removes the rekey and deletes the account from the ledger.
   * Only the partner or the card holder can call this function.
   * @param card Address to close
   */
  public cardClose(card: Account): void {
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')
    const cardOwner = this.cards(card).value.owner
    assert(this.isPartner() || cardOwner === Txn.sender, 'SENDER_NOT_ALLOWED')

    // Drop any pending request the holder had against this card before the card box goes away,
    // otherwise the request box outlives the card it points at and can never be cleaned up.
    this.clearWithdrawalRequest(cardOwner, card)

    // Close the card account back to the contract, returning its balance to the
    // owner-funded pool. Deleting the box releases its MBR back to the contract too.
    itxn
      .payment({
        sender: card,
        receiver: Global.currentApplicationAddress,
        amount: 0,
        closeRemainderTo: Global.currentApplicationAddress,
      })
      .submit()

    // Delete the card from the box
    this.cards(card).delete()

    // Decrement active cards
    this.cards_active_count.value = this.cards_active_count.value - 1
  }

  /**
   * Recovers funds from an old card and transfers them to a new card.
   * Only the owner of the contract can perform this operation.
   *
   * @param card - The card to recover.
   * @param newCardHolder - The address of the new card holder.
   */
  public cardRecover(card: Account, newCardHolder: Account): void {
    this.onlyOwner()
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')

    const oldCardHolder = this.cards(card).value.owner

    // A request created by the previous holder must not survive the hand-over: it is keyed by
    // their account, so the new holder can neither complete nor cancel it.
    this.clearWithdrawalRequest(oldCardHolder, card)

    this.cards(card).value.owner = newCardHolder

    emit<CardRecovered>({
      card: card,
      oldCardOwner: oldCardHolder,
      newCardOwner: newCardHolder,
    })
  }

  /**
   * Debits the specified amount of the given asset from the card account.
   * Only a withdraw operator can perform this operation.
   *
   * The AutoDraw lsig binds `card` and `cardOwner` to the axfer receiver, so verifying here that
   * `cardOwner` owns `card` prevents the delegated draw from funding (and subsequently
   * debiting) a card the account does not own.
   *
   * @param card The card from which the asset will be debited.
   * @param asset The asset to be debited.
   * @param amount The amount of the asset to be debited.
   */
  public cardDebit(cardOwner: Account, card: Account, asset: Asset, amount: uint64, nonce: uint64, ref: string): void {
    this.whenNotPaused()
    this.onlyWithdrawOperator()

    // Ensure card and owner align
    assert(this.cards(card).value.owner === cardOwner, 'OWNER_INVALID')

    // Ensure the nonce is correct
    const nextNonce: uint64 = this.cards(card).value.nonce
    assert(nextNonce === nonce, 'NONCE_INVALID')

    itxn
      .assetTransfer({
        sender: card,
        assetReceiver: this.omnibus_address.value,
        xferAsset: asset,
        assetAmount: amount,
        note: ref,
      })
      .submit()

    emit<Debit>({
      card: card,
      asset: asset,
      amount: amount,
      nonce: nonce,
      reference: ref,
    })

    // Increment the nonce
    this.cards(card).value.nonce = nextNonce + 1
  }

  /**
   * Retrieves the next available nonce for the card.
   *
   * @param card The card address.
   * @returns The nonce for the card.
   */
  @abimethod({ readonly: true })
  public getNextCardNonce(card: Account): uint64 {
    return this.cards(card).value.nonce
  }

  /**
   * Retrieves the card data for a given card address.
   *
   * @param card The address of the card.
   * @returns The card data.
   */
  @abimethod({ readonly: true })
  public getCardData(card: Account): CardData {
    return this.cards(card).value
  }

  /**
   * Sets the partner address.
   * Only the owner of the contract can call this method.
   *
   * @param newPartnerAddress The new partner address to be set.
   */
  public setPartnerAddress(newPartnerAddress: Account): void {
    this.onlyOwner()

    this.partner_address.value = newPartnerAddress
  }

  /**
   * Sets the omnibus address.
   * Only the owner of the contract can call this method.
   *
   * @param newOmnibusAddress The new omnibus address to be set.
   */
  public setOmnibusAddress(newOmnibusAddress: Account): void {
    this.onlyOwner()

    this.omnibus_address.value = newOmnibusAddress
  }

  /**
   * Sets the Killswitch application whose AutoDraw delegations are revoked when a card opts out
   * of an asset. The app id is owner-controlled rather than passed in per call, so a caller
   * cannot point the revocation at a look-alike contract and have the real delegation survive.
   * Only the owner of the contract can call this method.
   *
   * @param newKillswitchApp The Killswitch application to register.
   */
  public setKillswitchApp(newKillswitchApp: Application): void {
    this.onlyOwner()

    this.killswitch_app.value = newKillswitchApp
  }

  /**
   * Authorize an account as a withdraw operator, allowing it to call cardDebit.
   * Only the owner of the contract can call this method.
   *
   * @param operator The account to authorize.
   */
  public addWithdrawOperator(operator: Account): void {
    this.onlyOwner()

    this.withdraw_operators(operator).value = 1
  }

  /**
   * Revoke a withdraw operator. Deleting the box releases its MBR back to the
   * contract. Only the owner of the contract can call this method.
   *
   * @param operator The account to revoke.
   */
  public removeWithdrawOperator(operator: Account): void {
    this.onlyOwner()

    this.withdraw_operators(operator).delete()
  }

  // ===== Card Holder Methods =====
  /**
   * Allows the card holder (or partner) to CloseOut of an asset, reducing the minimum balance
   * requirement of the account. The freed MBR — along with any other surplus Algo on the card —
   * is swept back to the contract escrow that sponsored it.
   *
   * The holder's AutoDraw delegation for the asset goes with it. Opting the card out is the point
   * at which the asset can no longer be drawn into it, and it is the only chokepoint that catches
   * every case — a card cannot be closed while it still holds an ASA, so every asset a card ever
   * held passes through here. Revoking is best-effort, so an asset that was never delegated
   * closes out normally.
   *
   * @param card - The address of the card.
   * @param asset - The ID of the asset to be removed.
   */
  public cardDisableAsset(card: Account, asset: Asset): void {
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')
    const cardOwner = this.cards(card).value.owner
    assert(this.isPartner() || cardOwner === Txn.sender, 'SENDER_NOT_ALLOWED')

    this.cardAssetCloseOut(card, asset)
    this.killDelegation(cardOwner, asset)
  }

  /**
   * Allows the card holder to request a withdrawal of an amount of assets from the account
   * @param card Address to withdraw from
   * @param asset Asset to withdraw
   * @param amount Amount to withdraw
   */
  @abimethod({ allowActions: ['NoOp'] })
  public withdrawalRequest(card: Account, asset: Asset, amount: uint64): WithdrawalRequest {
    this.onlyCardOwner(card)
    const cardData = clone(this.cards(card).value)
    const [balance] = op.AssetHolding.assetBalance(card, asset)
    assert(amount <= balance, 'INSUFFICIENT_BALANCE')

    const withdrawal: WithdrawalRequest = {
      card: card,
      recipient: Txn.sender,
      asset: asset,
      amount: amount,
      createdAt: Global.latestTimestamp,
      nonce: cardData.withdrawalNonce,
    }

    this.withdrawals(Txn.sender).value = clone(withdrawal)

    emit<WithdrawalRequest>(withdrawal)

    return withdrawal
  }

  /**
   * Allows the card holder to cancel a withdrawal request
   * @param card Address to withdraw from
   */
  public withdrawalCancel(card: Account): void {
    this.onlyCardOwner(card)
    assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND')
    const withdrawal = clone(this.withdrawals(Txn.sender).value)
    this.withdrawals(Txn.sender).delete()
    emit<WithdrawalRequestCancelled>(withdrawal)
  }

  /**
   * Allows the card holder to send an amount of assets from the account
   * @param card Address to withdraw from
   */
  @abimethod({ allowActions: ['NoOp'] })
  public withdraw(card: Account, amount: uint64): void {
    this.onlyCardOwner(card)
    assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND')
    const cardData = clone(this.cards(card).value)
    const withdrawal = clone(this.withdrawals(Txn.sender).value)
    assert(amount <= withdrawal.amount, 'AMOUNT_INVALID')
    assert(cardData.withdrawalNonce === withdrawal.nonce, 'NONCE_INVALID')
    assert(withdrawal.card === card, 'CARD_MISMATCH')

    const releaseTime: uint64 = withdrawal.createdAt + this.withdrawal_wait_time.value
    assert(Global.latestTimestamp >= releaseTime, 'WITHDRAWAL_TIME_INVALID')

    // Issue the withdrawal
    this.withdrawFunds(
      card,
      withdrawal.asset,
      amount,
      withdrawal.createdAt,
      withdrawal.nonce,
      WithdrawalTypePermissionLess,
    )
    this.withdrawals(Txn.sender).delete()
  }

  /**
   * Withdraws funds before the withdrawal timestamp has lapsed, by using the permissioned withdrawal signature provided by partner.
   * @param card - The address of the card.
   * @param asset - The ID of the asset to be withdrawn.
   * @param amount - The amount of the withdrawal.
   * @param expiresAt - The expiry of the withdrawal signature.
   * @param signature - The signature for permissioned withdrawal.
   */
  public withdrawPermissioned(
    card: Account,
    asset: Asset,
    amount: uint64,
    expiresAt: uint64,
    nonce: uint64,
    signature: bytes<64>,
  ): void {
    this.onlyCardOwner(card)
    const cardData = clone(this.cards(card).value)

    assert(Global.latestTimestamp < expiresAt, 'WITHDRAWAL_TIME_INVALID')
    assert(cardData.withdrawalNonce === nonce, 'NONCE_INVALID')

    const withdrawal: PermissionedWithdrawal = {
      card,
      recipient: Txn.sender,
      asset,
      amount,
      expiresAt,
      nonce,
      genesisHash: Global.genesisHash,
    }

    const withdrawal_hash = op.sha256(arc4.encodeArc4(withdrawal))

    // Need at least 2500 Opcode budget
    ensureBudget(2500)

    assert(op.ed25519verifyBare(withdrawal_hash, signature, this.withdrawal_pubkey.value), 'SIGNATURE_INVALID')

    // Issue the withdrawal
    this.withdrawFunds(card, asset, amount, expiresAt, cardData.withdrawalNonce, WithdrawalTypeApproved)

    // A permissioned withdrawal supersedes any pending permissionless request for
    // the sender. Clean it up to release its box MBR and avoid orphaning the box, since
    // issuing the withdrawal increments the nonce and makes the request un-executable.
    if (this.withdrawals(Txn.sender).exists) {
      this.withdrawals(Txn.sender).delete()
    }
  }

  // ========== Refund ==========
  // ===== Owner Methods =====
  /**
   * Sets the refund signer public key. Rotating it invalidates every unsubmitted
   * signature, which is the intended emergency response.
   * Only the owner of the contract can call this method.
   *
   * @param pubkey The public key to set.
   */
  public setRefundSignerPubkey(pubkey: bytes<32>): void {
    this.onlyOwner()

    this.refund_pubkey.value = pubkey
  }

  /**
   * Authorize an account as a refund operator.
   * Only the owner of the contract can call this method.
   *
   * @param operator The account to authorize.
   */
  public addRefundOperator(operator: Account): void {
    this.onlyOwner()

    this.refund_operators(operator).value = 1
  }

  /**
   * Revoke a refund operator. Deleting the box releases its MBR back to the
   * contract. Only the owner of the contract can call this method.
   *
   * @param operator The account to revoke.
   */
  public removeRefundOperator(operator: Account): void {
    this.onlyOwner()

    this.refund_operators(operator).delete()
  }

  /**
   * Retrieves the next available nonce for the treasury.
   * Fails while no treasury exists — see treasuryAssetOptIn.
   *
   * @returns The nonce for the treasury.
   */
  @abimethod({ readonly: true })
  public getNextTreasuryNonce(): uint64 {
    assert(this.treasury.hasValue, 'TREASURY_NOT_FOUND')
    return this.treasury.value.nonce
  }

  /**
   * Opt the treasury into an asset so refunds of that asset can be paid from it, creating the
   * treasury account on the first call. Any shortfall in the treasury's minimum balance
   * requirement is topped up from the contract escrow, so the caller does not have to fund the
   * treasury directly.
   * A treasury already opted into the asset is rejected, since the call would do nothing.
   * Only the owner of the contract can call this method.
   * @param asset Asset to opt-in to
   * @returns The treasury account address
   */
  public treasuryAssetOptIn(asset: Asset): Account {
    this.onlyOwner()

    // The treasury is created lazily, on the first opt-in rather than at deploy time: a freshly
    // rekeyed account must be funded to its minimum balance within the same group as the rekey,
    // and at creation the app account holds nothing to fund it with. By the first opt-in the
    // escrow is funded, so the account is created, rekeyed and funded in one breath — the same
    // pattern as cardCreate. Writing the global here too (rather than at deploy) means a live
    // deployment gains the refund feature through a plain contract update, with no state
    // migration.
    if (!this.treasury.hasValue) {
      const controlledAddr = compile(ControlledAddress)
      this.treasury.value = {
        address: arc4.abiCall<typeof ControlledAddress.prototype.new>({
          approvalProgram: controlledAddr.approvalProgram,
          clearStateProgram: controlledAddr.clearStateProgram,
          onCompletion: OnCompleteAction.DeleteApplication,
        }).returnValue,
        nonce: 0,
      }
    }

    const treasuryAddress = this.treasury.value.address

    const [, alreadyOptedIn] = op.AssetHolding.assetBalance(treasuryAddress, asset)
    assert(!alreadyOptedIn, 'ASSET_ALREADY_ENABLED')

    // A just-created treasury is not on the ledger yet — it exists only once funded — and the
    // plain account balance properties refuse to read an account that does not exist. Read via
    // the non-asserting ops instead, flooring the requirement at the base account minimum so
    // the first top-up funds the account into existence along with its asset slot.
    const [balance] = op.AcctParams.acctBalance(treasuryAddress)
    const [minBalance, funded] = op.AcctParams.acctMinBalance(treasuryAddress)
    const base: uint64 = funded && minBalance > Global.minBalance ? minBalance : Global.minBalance
    const required: uint64 = base + Global.assetOptInMinBalance
    if (balance < required) {
      itxn
        .payment({
          receiver: treasuryAddress,
          amount: required - balance,
        })
        .submit()
    }

    itxn
      .assetTransfer({
        sender: treasuryAddress,
        assetReceiver: treasuryAddress,
        xferAsset: asset,
        assetAmount: 0,
      })
      .submit()

    emit<TreasuryAssetEnabled>({
      treasury: treasuryAddress,
      asset: asset,
    })

    return treasuryAddress
  }

  /**
   * Close the treasury out of an asset, sending any remaining balance of that asset to
   * `closeTo`, and sweep the Algo the treasury no longer needs back to the contract escrow.
   *
   * Unlike a card close-out, the remaining asset balance here is live refund float rather than
   * an already-drained holding, so it goes to an explicit recipient — which must already hold
   * the asset. The sweep reads the balance after the close-out, so it returns the freed
   * asset-slot MBR plus any other surplus and leaves the treasury at exactly its remaining
   * minimum balance.
   * Only the owner of the contract can call this method.
   * @param asset Asset to close out of
   * @param closeTo Account receiving the treasury's remaining balance of the asset
   */
  public treasuryAssetCloseOut(asset: Asset, closeTo: Account): void {
    this.onlyOwner()
    assert(this.treasury.hasValue, 'TREASURY_NOT_FOUND')
    const treasuryAddress = this.treasury.value.address

    itxn
      .assetTransfer({
        sender: treasuryAddress,
        assetReceiver: closeTo,
        assetCloseTo: closeTo,
        xferAsset: asset,
        assetAmount: 0,
      })
      .submit()

    if (treasuryAddress.balance > treasuryAddress.minBalance) {
      itxn
        .payment({
          sender: treasuryAddress,
          receiver: Global.currentApplicationAddress,
          amount: treasuryAddress.balance - treasuryAddress.minBalance,
        })
        .submit()
    }

    emit<TreasuryAssetDisabled>({
      treasury: treasuryAddress,
      asset: asset,
    })
  }

  /**
   * Close the treasury account, permanently removing it from the ledger and returning its
   * balance to the contract escrow — the treasury counterpart of cardClose. The treasury must
   * already be closed out of every asset (Algorand forbids closing an account that still holds
   * an ASA — see treasuryAssetCloseOut).
   *
   * Deleting the treasury state returns the contract to its pre-treasury shape, so a later
   * treasuryAssetOptIn starts over with a brand-new account at nonce 0. That reset is safe:
   * signatures are verified against a batch rebuilt around the treasury address, so anything
   * minted for the old treasury cannot verify against its replacement.
   * Only the owner of the contract can call this method.
   */
  public treasuryClose(): void {
    this.onlyOwner()
    assert(this.treasury.hasValue, 'TREASURY_NOT_FOUND')

    itxn
      .payment({
        sender: this.treasury.value.address,
        receiver: Global.currentApplicationAddress,
        amount: 0,
        closeRemainderTo: Global.currentApplicationAddress,
      })
      .submit()

    this.treasury.delete()
  }

  /**
   * Refunds card debits that have already settled on chain, by paying the amounts out of the
   * treasury against a signature provided by partner.
   *
   * This is a compensating payment, not a rollback: a cardDebit inner transfer is final once
   * committed, so the funds are moved forward out of the treasury rather than reversed out of
   * the omnibus.
   *
   * The whole batch is one signature and one nonce, so it either pays every recipient or none of
   * them; a partially applied refund cannot be left behind for an operator to finish.
   *
   * Two group requirements cannot be asserted from in here and are the caller's to satisfy:
   * every (recipient, asset) holding plus the (treasury, asset) holding must be made available
   * through the group's access lists (16 entries per app call, shared group-wide). Each
   * recipient costs an address entry plus a holding entry, the batch as a whole needs the
   * asset, the sender's refund-operator box and the treasury's address and holding, and a
   * holding entry is encoded against address and asset entries in the same call's list — so
   * this call fits six recipients, each pad app call fits the asset plus seven more, and a
   * full 48-recipient batch needs this call plus six pads. And the group must over-pay by one
   * minimum fee per inner transaction, since puya emits a zero fee on inner transactions and
   * they are paid out of the group's fee credit.
   *
   * @param transfers - The recipient/amount pairs to pay, up to MaxRefundTransfers entries.
   * @param asset - The ID of the asset to refund.
   * @param expiresAt - The expiry of the refund signature.
   * @param nonce - The expected treasury nonce.
   * @param signature - The signature authorising the refund.
   */
  public cardRefund(
    transfers: RefundTransfer[],
    asset: Asset,
    expiresAt: uint64,
    nonce: uint64,
    signature: bytes<64>,
  ): void {
    this.whenNotPaused()
    assert(this.refund_operators(Txn.sender).exists, 'SENDER_NOT_ALLOWED')
    assert(this.treasury.hasValue, 'TREASURY_NOT_FOUND')
    const treasuryAddress = this.treasury.value.address

    const count: uint64 = transfers.length
    assert(count > 0, 'NO_TRANSFERS')
    assert(count <= MaxRefundTransfers, 'TOO_MANY_TRANSFERS')
    assert(Global.latestTimestamp < expiresAt, 'REFUND_TIME_INVALID')
    assert(this.treasury.value.nonce === nonce, 'NONCE_INVALID')

    // Rebuilt from state rather than from caller input, so a signature minted against a
    // different treasury or network cannot verify here.
    const refund: RefundBatch = {
      treasury: treasuryAddress,
      asset,
      expiresAt,
      nonce,
      genesisHash: Global.genesisHash,
      transfers: clone(transfers),
    }

    // Signature verification is a flat 1900, but encoding and hashing the batch and issuing the
    // inner transfers scale with its size.
    ensureBudget(2500 + 70 * count)

    const refund_hash = op.sha256(arc4.encodeArc4(refund))

    assert(op.ed25519verifyBare(refund_hash, signature, this.refund_pubkey.value), 'SIGNATURE_INVALID')

    // Consume the nonce so the signature is single-use
    this.treasury.value.nonce = nonce + 1

    // Indexed with the fields read inline, rather than for-of over a bound local: puya rejects
    // both iterating and assigning a mutable stack type without clone(), and cloning here would
    // copy the whole batch for no benefit.
    let total: uint64 = 0
    for (let i: uint64 = 0; i < count; i = i + 1) {
      const amount = transfers[i].amount

      // if amount is zero, we skip the asset transfer
      if (amount > 0) {
        itxn
          .assetTransfer({
            sender: treasuryAddress,
            assetReceiver: transfers[i].recipient,
            xferAsset: asset,
            assetAmount: amount,
          })
          .submit()
      }

      total = total + amount
    }

    emit<Refund>({
      treasury: treasuryAddress,
      asset: asset,
      count: count,
      total: total,
      expiresAt: expiresAt,
      nonce: nonce,
    })
  }
}
