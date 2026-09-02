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
  assert,
  Contract,
  emit,
  Global,
  GlobalState,
  Txn,
} from '@algorandfoundation/algorand-typescript'

type OwnershipTransferred = {
  previousOwner: Account
  newOwner: Account
}

export class Ownable extends Contract {
  // ========== State Variables ==========
  /**
   * Owner of the contract
   */
  public _owner = GlobalState<Account>()

  // ========== Access Checks ==========
  /**
   * Assert the transaction sender is the owner of the contract.
   */
  protected onlyOwner(): void {
    assert(Txn.sender === this._owner.value, 'SENDER_NOT_ALLOWED')
  }

  /**
   * Checks if the current transaction sender is the owner.
   * @returns boolean True if the sender is the owner, false otherwise.
   */
  protected isOwner(): boolean {
    return Txn.sender === this._owner.value
  }

  // ========== Read Only ==========
  @abimethod({ readonly: true })
  public owner(): Account {
    return this._owner.value
  }

  // ========== Internal Utils ==========
  /**
   * Transfers the ownership of the contract to a new owner.
   * @param newOwner The address of the new owner.
   */
  protected _transferOwnership(newOwner: Account): void {
    const previousOwner = this._owner.hasValue ? this._owner.value : Global.zeroAddress
    this._owner.value = newOwner

    emit<OwnershipTransferred>({
      previousOwner: previousOwner,
      newOwner: newOwner,
    })
  }

  // ========== External Functions ==========
  /**
   * Transfers the ownership of the contract to a new owner.
   * Requires the caller to be the current owner.
   *
   * @param newOwner The address of the new owner.
   */
  public transferOwnership(newOwner: Account): void {
    this.onlyOwner()

    assert(newOwner !== Global.zeroAddress, 'ADDRESS_NOT_ALLOWED')
    this._transferOwnership(newOwner)
  }
}
