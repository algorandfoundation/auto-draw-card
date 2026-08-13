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
   * Opt-in a card into an asset. Minimum balance requirement must be met prior to calling this function.
   * Only the partner can call this function.
   * @param card Card address
   * @param asset Asset to opt-in to
   */
  public cardAssetOptIn(card: Account, asset: Asset): void {
    this.onlyPartner()
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')

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
   */
  @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
  public deploy(owner: Account, omnibus: Account): Account {
    this._transferOwnership(owner)
    this.setOmnibusAddress(omnibus)
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
   * Destroy the smart contract, sending all Algo to the owner account. This can only be done if there are no active cards
   */
  @abimethod({ allowActions: ['DeleteApplication'] })
  public destroy(): void {
    this.onlyOwner()

    // There must not be any active card
    assert(!this.cards_active_count.value, 'CARDS_STILL_ACTIVE')

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
    assert(this.isPartner() || this.isCardOwner(card), 'SENDER_NOT_ALLOWED')
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')

    // Drop any pending request the holder had against this card before the card box goes away,
    // otherwise the request box outlives the card it points at and can never be cleaned up.
    this.clearWithdrawalRequest(this.cards(card).value.owner, card)

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
   * requirement of the account. The freed MBR remains within the card account.
   *
   * @param card - The address of the card.
   * @param asset - The ID of the asset to be removed.
   */
  public cardDisableAsset(card: Account, asset: Asset): void {
    assert(this.isPartner() || this.isCardOwner(card), 'SENDER_NOT_ALLOWED')
    assert(this.cards(card).exists, 'CARD_NOT_FOUND')

    this.cardAssetCloseOut(card, asset)
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
}
