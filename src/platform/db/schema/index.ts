/**
 * Schema barrel. 25 tables, matching TECHNICAL_DESIGN §5.
 *
 * Import order reflects the FK dependency chain (§5.7):
 *   identity → trips → canvas → ledger → collab
 */

export * from './enums';
export * from './identity';
export * from './trips';
export * from './canvas';
export * from './ledger';
export * from './collab';
