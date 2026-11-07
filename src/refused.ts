/**
 * The statuses (401, 402, 403) of background events SignalVault refused for
 * the key or the account that have been warned about. Process-wide, not per
 * client: SignalVault refuses every event sent with such a key, from every
 * client that uses it, so each status is warned about once.
 */
const warned = new Set<number>();

/** True the first time it is called for `status` in this process. */
export function firstRefusal(status: number): boolean {
  if (warned.has(status)) return false;
  warned.add(status);
  return true;
}

/** Forgets which statuses were warned about. For tests. */
export function resetRefusalWarnings(): void {
  warned.clear();
}
