import { AsyncLocalStorage } from 'node:async_hooks';

const depth = new AsyncLocalStorage<number>();
let tail: Promise<void> = Promise.resolve();

/** True while the current async call already holds the vault write lock. */
export function vaultLockActive(): boolean {
  return (depth.getStore() ?? 0) > 0;
}

/**
 * Serializes vault mutations so a revision check and the write that follows
 * cannot interleave. Re-entrant: collection-index sync calls update from
 * inside update and must not deadlock.
 */
export function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  if (vaultLockActive()) return fn();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wait = tail;
  tail = gate;
  return wait.then(() => depth.run(1, fn)).finally(release);
}
