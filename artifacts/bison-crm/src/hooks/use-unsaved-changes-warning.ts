import { useEffect } from 'react';

/**
 * Warns before in-progress work is thrown away by navigation.
 *
 * Covers two escape routes while `enabled` is true:
 *  - closing / reloading the tab (native `beforeunload` prompt)
 *  - clicking an in-app link (wouter renders plain anchors, so a capture-phase
 *    click listener can intercept the navigation and ask first)
 *
 * Programmatic navigation (`setLocation`, browser Back) is not intercepted —
 * the History API gives no cancellable hook for it.
 */
export function useUnsavedChangesWarning(enabled: boolean, message: string) {
  useEffect(() => {
    if (!enabled) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    const onClickCapture = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname) return;

      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [enabled, message]);
}
