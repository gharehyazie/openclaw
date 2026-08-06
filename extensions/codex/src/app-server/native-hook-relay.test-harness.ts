/**
 * Test-only view of the Codex native hook relay owner registry. The registry
 * itself is production state; these seams keep inspection and teardown out of
 * the production module so it exports nothing tests alone consume.
 */
import { codexNativeHookRelayOwners } from "./native-hook-relay-state.js";

/** Disposes every live route so a case cannot leak an adopted relay into the next one. */
export function clearCodexNativeHookRelayOwners(): void {
  for (const owner of codexNativeHookRelayOwners.values()) {
    owner.dispose();
  }
  // dispose() evicts only routes it still owns; clear() drops entries a prior release left behind.
  codexNativeHookRelayOwners.clear();
}

/** Live route count, used to assert relay leases are released at attempt boundaries. */
export function codexNativeHookRelayOwnerCount(): number {
  return codexNativeHookRelayOwners.size;
}
