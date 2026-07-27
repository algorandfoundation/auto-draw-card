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
  Application,
  arc4,
  assert,
  bytes,
  Global,
  gtxn,
  LogicSig,
  OnCompleteAction,
  TemplateVar,
  Txn,
} from '@algorandfoundation/algorand-typescript'
import { btoi } from '@algorandfoundation/algorand-typescript/op'
import { Killswitch } from '../killswitch/contract.algo'
import { Main } from '../main/contract.algo'

export class AutoDraw extends LogicSig {
  public program() {
    // Resolve this Lsig's own transaction by its position in the group. Txn.groupIndex
    // is the index of the transaction currently being evaluated (the axfer this Lsig
    // signs), so referencing it relatively — rather than a hardcoded index like 0 —
    // lets the group be prefixed with other transactions (e.g. a fee-payer) without
    // breaking the relative offsets the killswitch and main-debit checks rely on below.
    const txnAutoDraw = gtxn.AssetTransferTxn(Txn.groupIndex)
    autoDrawAsserts(txnAutoDraw)
    killswitchAsserts(txnAutoDraw)
    mainDebitAsserts(txnAutoDraw)
    return true
  }
}

function autoDrawAsserts(txnAutoDraw: gtxn.AssetTransferTxn) {
  // Block rekeying: a rekey would hand control of the signing account to an
  // arbitrary key, letting the holder bypass this Lsig's checks on all future
  // transactions. The Lsig must never authorize a transaction that changes the
  // account's auth address.
  assert(txnAutoDraw.rekeyTo === Global.zeroAddress, 'REKEY_NOT_ALLOWED')
  // Block asset close-out: setting an assetCloseTo would drain the account's
  // entire remaining balance of the asset to a third party as a side effect of
  // the transfer. Only the explicit assetAmount may move.
  assert(txnAutoDraw.assetCloseTo === Global.zeroAddress, 'ASSET_CLOSE_NOT_ALLOWED')
  // Block clawback: in the event that the delegated account is the clawback
  // authority for an asset, setting assetSender would allow withdrawing from
  // any account holding the asset, not just the delegated one.
  assert(txnAutoDraw.assetSender === Global.zeroAddress, 'CLAWBACK_NOT_ALLOWED')
  // Pin to one network: the genesis hash is baked in at compile time via the
  // template variable, so a signature valid on (e.g.) TestNet cannot be replayed
  // against the same account on MainNet or any other chain.
  assert(Global.genesisHash === TemplateVar<bytes>('GENESIS_HASH'), 'BAD_NETWORK')
  // Require a zero fee: the signer must not let this Lsig spend the account's
  // Algo balance on fees. The fee is expected to be covered by another (fee-pooling)
  // transaction in the group, so this transaction itself must contribute nothing.
  assert(txnAutoDraw.fee === 0, 'NON-ZERO_FEE')
  return txnAutoDraw
}

function killswitchAsserts(txnAutoDraw: gtxn.AssetTransferTxn) {
  // Reference the transaction immediately after this Lsig's axfer (groupIndex + 1).
  // The Lsig enforces a fixed group layout: its own transfer must be directly followed
  // by the Killswitch.authorize app call. Using a relative offset off Txn.groupIndex
  // (instead of an absolute index) keeps this binding correct regardless of where the
  // axfer sits in the overall group, while still pinning the killswitch to the exact
  // next slot so no transaction can be inserted between them.
  const txnKillswitch = gtxn.ApplicationCallTxn(Txn.groupIndex + 1)
  const killswitchMethod = arc4.methodSelector<typeof Killswitch.prototype.authorize>()
  // Bind to the exact Killswitch application: the next transaction must target the
  // specific app id this Lsig was templated for, so the kill switch cannot be
  // satisfied by a look-alike or attacker-controlled application.
  assert(txnKillswitch.appId === TemplateVar<Application>('KILLSWITCH_APP'), 'BAD_KILLSWITCH_APP')
  // Require a NoOp call: only the approval program (not opt-in, close-out, update,
  // or delete) runs the authorize logic, so a different OnCompletion cannot be used
  // to sidestep the kill switch checks.
  assert(txnKillswitch.onCompletion === OnCompleteAction.NoOp, 'BAD_KILLSWITCH_OC')
  // Verify the method selector: appArgs(0) carries the ABI selector, so this proves
  // the call actually invokes Killswitch.authorize and not some other method on the
  // same application.
  assert(txnKillswitch.appArgs(0) === killswitchMethod, 'BAD_KILLSWITCH_METHOD')
  // Tie the authorization to this signer: appArgs(1) is the auth address passed to
  // authorize, and it must equal the account spending the asset, so the kill switch
  // is evaluated against the correct holder and cannot be authorized on someone
  // else's behalf.
  assert(txnKillswitch.appArgs(1) === txnAutoDraw.sender.bytes, 'AUTH_MISMATCH')
  // Tie the authorization to the transferred asset: appArgs(2) is the asset id passed
  // to authorize (decoded from bytes), and it must equal the asset actually moved.
  // Delegation is enabled per (account, asset) in the Killswitch, so this check —
  // rather than an asset baked into the Lsig template — is what restricts which ASA
  // the Lsig may transfer.
  assert(btoi(txnKillswitch.appArgs(2)) === txnAutoDraw.xferAsset.id, 'ASSET_MISMATCH_KILLSWITCH')
}

function mainDebitAsserts(txnAutoDraw: gtxn.AssetTransferTxn) {
  // Reference the second transaction after this Lsig's axfer (groupIndex + 2). The
  // enforced group layout is [axfer, Killswitch.authorize, Main.cardDebit], so the
  // debit-recording call must sit exactly two slots after the transfer. Deriving the
  // index relatively off Txn.groupIndex keeps this position correct no matter where
  // the axfer lands in the group, while still requiring the cardDebit call to occupy
  // this precise slot so the transfer is always accompanied by its accounting entry.
  const txnMainDebit = gtxn.ApplicationCallTxn(Txn.groupIndex + 2)
  const mainMethod = arc4.methodSelector<typeof Main.prototype.cardDebit>()
  // Bind to the exact Main application: the debit-recording call must target the
  // specific app id this Lsig was templated for, so the transfer can only be
  // accounted for by the legitimate Main contract.
  assert(txnMainDebit.appId === TemplateVar<Application>('MAIN_APP'), 'BAD_MAIN_APP')
  // Require a NoOp call: only the approval program path runs cardDebit's accounting
  // logic, so a different OnCompletion cannot be used to skip recording the debit.
  assert(txnMainDebit.onCompletion === OnCompleteAction.NoOp, 'BAD_MAIN_OC')
  // Verify the method selector: appArgs(0) must be the cardDebit ABI selector, proving
  // this call records the debit rather than invoking some other method on Main.
  assert(txnMainDebit.appArgs(0) === mainMethod, 'BAD_MAIN_METHOD')
  // Cross-check the sender: the account Main debits (appArgs(1)) must be the same
  // account actually sending the asset, so the on-ledger transfer and the recorded
  // debit always refer to the same payer.
  assert(txnMainDebit.appArgs(1) === txnAutoDraw.sender.bytes, 'SENDER_MISMATCH')
  // Cross-check the receiver: the receiver Main records (appArgs(2)) must match the
  // actual asset receiver, preventing the debit from being attributed to a different
  // destination than where the funds went.
  assert(txnMainDebit.appArgs(2) === txnAutoDraw.assetReceiver.bytes, 'RECEIVER_MISMATCH')
  // Cross-check the asset: the asset id passed to cardDebit (appArgs(3), decoded from
  // bytes) must equal the asset actually transferred, so the debit is recorded against
  // the correct ASA.
  assert(btoi(txnMainDebit.appArgs(3)) === txnAutoDraw.xferAsset.id, 'ASSET_MISMATCH_MAIN')
  // Bound the transfer by the debited amount: the amount authorized in cardDebit
  // (appArgs(4)) must be at least the amount actually transferred, ensuring the asset
  // movement never exceeds what Main has accounted/approved (a smaller transfer is fine).
  assert(btoi(txnMainDebit.appArgs(4)) >= txnAutoDraw.assetAmount, 'BAD_AMOUNT')
}
