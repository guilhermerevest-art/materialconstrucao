import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | Balcão` : 'Balcão';
  }, [title]);
}

/** Atalhos de teclado da página (F2, F4, F9...). O handler mais recente é sempre usado. */
export function useHotkeys(handlers: Record<string, (event: KeyboardEvent) => void>) {
  const ref = useRef(handlers);
  useLayoutEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const combo = `${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.key}`;
      const handler = ref.current[combo];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
