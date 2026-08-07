/**
 * Pure money arithmetic. Zero dependencies, zero knowledge of the domain.
 *
 * Three rules enforced by review and by the `no-restricted-syntax` lint rule:
 *   1. `number` never holds money. Ever. `bigint` or a minor-unit string.
 *   2. Money crosses the wire as a decimal STRING — JSON.stringify throws on
 *      bigint, and Number loses precision above 2^53.
 *   3. Two amounts in different currencies are never added.
 */

export {
  RATE_SCALE,
  assertCurrency,
  convertMinor,
  divRound,
  exponentOf,
  formatMinor,
  formatRate,
  isValidCurrency,
  parseMinor,
  parseRate,
} from './currency';

export {
  allocate,
  allocateBoth,
  allocateEqual,
  allocateWithAdjustments,
  sumAllocation,
} from './allocate';

export type { AllocationPair, Weight } from './allocate';

export {
  LedgerImbalanceError,
  applyTransfers,
  isFullySettled,
  nettedPairwise,
  simplify,
} from './settle';

export type { Transfer } from './settle';

/** Serialise minor units for transport. See rule 2 above. */
export const toWire = (minor: bigint): string => minor.toString();

/** Parse minor units from transport, rejecting anything non-integral. */
export function fromWire(value: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`Expected an integer minor-unit string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}
