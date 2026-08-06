type PendingUnregister = {
  timeout: ReturnType<typeof setTimeout>;
  unregister: () => void;
};

const pending = new Set<PendingUnregister>();

// Structural view of a relay route: keeping route types out of this module lets
// `native-hook-relay.ts` own the registry without an import cycle.
type CodexNativeHookRelayRouteEntry = { dispose: () => void };

/** Live relay routes by relay id; routes are the only writers, test teardown only disposes. */
export const codexNativeHookRelayOwners = new Map<string, CodexNativeHookRelayRouteEntry>();

/** Owns delayed hook-relay cleanup across runtime scheduling and test teardown. */
export const nativeHookRelayUnregisterQueue = {
  add(entry: PendingUnregister): void {
    pending.add(entry);
  },
  delete(entry: PendingUnregister): boolean {
    return pending.delete(entry);
  },
  flush(): void {
    while (pending.size > 0) {
      const entry = pending.values().next().value;
      if (!entry) {
        return;
      }
      clearTimeout(entry.timeout);
      entry.unregister();
    }
  },
  clear(): void {
    for (const entry of pending) {
      clearTimeout(entry.timeout);
    }
    pending.clear();
  },
};
