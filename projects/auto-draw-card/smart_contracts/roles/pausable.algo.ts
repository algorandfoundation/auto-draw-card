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
import { Account, assert, emit, Global, GlobalState, Txn } from '@algorandfoundation/algorand-typescript'
import { Ownable } from './ownable.algo'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- ARC28 event with no fields
type Pause = {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- ARC28 event with no fields
type Unpause = {}
type PauserChanged = { newAddress: Account }

export class Pausable extends Ownable {
  // ============ State Variables ============
  public _pauser = GlobalState<Account>()

  public paused = GlobalState<boolean>()

  // ============ Access Checks ============
  /**
   * @dev Modifier to make a function callable only when the contract is not paused.
   */
  protected whenNotPaused(): void {
    assert(!this.paused.value, 'CONTRACT_PAUSED')
  }

  /**
   * @dev throws if called by any account other than the pauser
   */
  protected onlyPauser(): void {
    assert(Txn.sender === this._pauser.value, 'SENDER_NOT_ALLOWED')
  }

  // ============ Read Only ============
  /**
   * @notice Returns current pauser
   * @return Pauser's address
   */
  public pauser(): Account {
    return this._pauser.value
  }

  // ============ External Functions ============
  /**
   * @dev called by the owner to pause, triggers stopped state
   */
  public pause(): void {
    this.onlyPauser()

    this.paused.value = true
    emit<Pause>({})
  }

  /**
   * @dev called by the owner to unpause, returns to normal state
   */
  public unpause(): void {
    this.onlyPauser()

    this.paused.value = false
    emit<Unpause>({})
  }

  /**
   * @dev update the pauser role
   */
  public updatePauser(_newPauser: Account): void {
    this.onlyOwner()

    assert(_newPauser !== Global.zeroAddress, 'ADDRESS_NOT_ALLOWED')
    this._pauser.value = _newPauser
    emit<PauserChanged>({ newAddress: this._pauser.value })
  }
}
