import { useSyncExternalStore } from 'react';
import { store, AppState } from './store';

export function useWoprStore(): AppState {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getState()
  );
}
