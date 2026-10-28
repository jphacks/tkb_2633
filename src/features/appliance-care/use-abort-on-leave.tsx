import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useNavigation } from 'expo-router';

/** Native stacks can retain an unfocused screen. Stop its client polling on both blur and unmount. */
export function useAbortApplianceRequestOnLeave(requestRef: RefObject<AbortController | null>) {
  const navigation = useNavigation();
  useEffect(() => {
    const abort = () => requestRef.current?.abort();
    const unsubscribe = navigation.addListener('blur', abort);
    return () => { unsubscribe(); abort(); };
  }, [navigation, requestRef]);
  // Detach an aborted attempt synchronously, even if its transport ignores abort and settles much later.
  return (onAbort: () => void) => {
    const controller = new AbortController(); requestRef.current = controller;
    controller.signal.addEventListener('abort', () => {
      if (requestRef.current !== controller) return;
      requestRef.current = null; onAbort();
    }, { once: true });
    return controller;
  };
}
