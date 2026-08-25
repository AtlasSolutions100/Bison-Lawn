import { useEffect, useRef } from 'react';

/** Marker stored on the extra history entry the guard owns while it is armed. */
const GUARD_ENTRY_KEY = '__unsavedChangesGuard';

type HistoryState = Record<string, unknown> | null;

const readHistoryState = (): HistoryState => {
  const state = window.history.state as unknown;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
};

const isGuardEntry = (state: HistoryState) => state?.[GUARD_ENTRY_KEY] === true;

/**
 * Warns before in-progress work is thrown away by navigation.
 *
 * Covers every escape route out of the page while `enabled` is true:
 *  - closing / reloading the tab (native `beforeunload` prompt)
 *  - clicking an in-app link (wouter renders plain anchors, so a capture-phase
 *    click listener can intercept the navigation and ask first)
 *  - browser Back / Forward, and programmatic navigation (`setLocation`)
 *
 * The History API has no cancellable hook, so the last two are handled by
 * owning an extra "guard" history entry: while armed, the guard pushes a
 * duplicate of the current URL onto the stack. Back then pops that entry
 * instead of leaving the page, which gives us a chance to confirm and — if the
 * admin cancels — push the guard entry straight back, leaving the URL and all
 * component state untouched. Programmatic pushes are undone the same way, with
 * a synchronous `replaceState` so the router never renders the destination.
 *
 * The guard entry is reclaimed as soon as the guard disarms (work saved or
 * discarded, page unmounted, navigation confirmed), so pressing Back after
 * leaving walks the same URLs it would have without the guard.
 */
export function useUnsavedChangesWarning(enabled: boolean, message: string) {
  const messageRef = useRef(message);
  messageRef.current = message;

  // A pop the guard itself asked for (removing its own entry); the next
  // `popstate` must not be read as the admin pressing Back.
  const selfPopRef = useRef(false);
  // Set while the guard rewrites history itself, so its own `pushState` /
  // `replaceState` events are not mistaken for navigation away from the page.
  const selfWriteRef = useRef(false);
  // Set once the admin has already confirmed leaving via an in-app link.
  const confirmedLeaveRef = useRef(false);

  // Guard entry: browser Back/Forward and programmatic navigation.
  useEffect(() => {
    if (!enabled) return;

    const guardedUrl = window.location.href;
    const guardedPath = window.location.pathname;
    let armed = true;

    const pushGuardEntry = () => {
      selfWriteRef.current = true;
      window.history.pushState({ ...(readHistoryState() ?? {}), [GUARD_ENTRY_KEY]: true }, '', guardedUrl);
      selfWriteRef.current = false;
    };

    const restoreGuardEntry = () => {
      selfWriteRef.current = true;
      window.history.replaceState({ ...(readHistoryState() ?? {}), [GUARD_ENTRY_KEY]: true }, '', guardedUrl);
      selfWriteRef.current = false;
    };

    /**
     * Called once the admin has confirmed a router push that landed the
     * destination on top of the guard entry. Steps back onto the guard entry
     * and overwrites it with the destination, so leaving the page costs
     * exactly one history entry — the same shape as an unguarded navigation.
     */
    const consumeBuriedGuardEntry = () => {
      const destinationUrl = window.location.href;
      const destinationState = readHistoryState();

      const onGuardEntryReached = () => {
        window.clearTimeout(safetyTimer);
        window.removeEventListener('popstate', onGuardEntryReached);
        // Only ever rewrite the guard's own entry.
        if (!isGuardEntry(readHistoryState())) return;
        selfWriteRef.current = true;
        window.history.replaceState(destinationState, '', destinationUrl);
        selfWriteRef.current = false;
      };

      // If the browser drops the traversal, stop listening rather than risk
      // acting on an unrelated Back press later on.
      const safetyTimer = window.setTimeout(() => {
        window.removeEventListener('popstate', onGuardEntryReached);
      }, 1500);

      window.addEventListener('popstate', onGuardEntryReached);
      setTimeout(() => window.history.back(), 0);
    };

    /**
     * Called after a cancelled router push has been rewritten back into a
     * guard entry: the stack now holds two of them, so step off the copy. Both
     * entries carry the guarded URL, so nothing changes on screen.
     */
    const dropDuplicateGuardEntry = () => {
      selfPopRef.current = true;
      setTimeout(() => window.history.back(), 0);
    };

    const disarm = () => {
      armed = false;
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pushState', onProgrammaticNavigation);
      window.removeEventListener('replaceState', onProgrammaticNavigation);
    };

    function onPopState() {
      if (!armed) return;

      if (selfPopRef.current) {
        // The guard removed its own entry. If it is still armed (a previous
        // run disarmed while this one was arming), take the entry back.
        selfPopRef.current = false;
        if (!isGuardEntry(readHistoryState())) pushGuardEntry();
        return;
      }

      // Still sitting on the guard entry: nothing was discarded.
      if (isGuardEntry(readHistoryState())) return;

      if (window.confirm(messageRef.current)) {
        // Accepted: step back past the entry the guard was protecting. Nothing
        // is left to protect afterwards, so stop listening either way. The
        // traversal is deferred because a browser can drop a `back()` issued
        // while it is still settling the pop that got us here.
        disarm();
        setTimeout(() => window.history.back(), 0);
        return;
      }

      // Cancelled: take the guard entry back. The URL never changed (the entry
      // is a duplicate of it), so the page and its state stay exactly as they
      // were.
      pushGuardEntry();
    }

    function onProgrammaticNavigation(event: Event) {
      if (!armed || selfWriteRef.current) return;
      if (confirmedLeaveRef.current) {
        confirmedLeaveRef.current = false;
        return;
      }
      // Same page (e.g. a query-string update) is not a navigation away.
      if (window.location.pathname === guardedPath) return;

      if (window.confirm(messageRef.current)) {
        disarm();
        // A push stacked the destination on top of the guard entry, which has
        // to be reclaimed. A replace overwrote the guard entry itself, so
        // there is nothing left behind.
        if (event.type === 'pushState') consumeBuriedGuardEntry();
        return;
      }
      // Cancelled: rewrite the entry the router just created back into the
      // guard entry. This happens synchronously inside the history event, so
      // the router re-reads the guarded URL and never renders the destination.
      restoreGuardEntry();
      // A push left that rewritten entry sitting on top of the original guard
      // entry; a replace consumed the original, so only a push has a copy to
      // give back.
      if (event.type === 'pushState') dropDuplicateGuardEntry();
    }

    pushGuardEntry();
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pushState', onProgrammaticNavigation);
    window.addEventListener('replaceState', onProgrammaticNavigation);

    return () => {
      disarm();
      // Give the extra entry back so it does not linger in the history stack.
      if (isGuardEntry(readHistoryState())) {
        selfPopRef.current = true;
        setTimeout(() => window.history.back(), 0);
      }
    };
  }, [enabled]);

  // Tab close / reload, and in-app link clicks.
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
        return;
      }

      if (isGuardEntry(readHistoryState())) {
        // Confirmed: spend the guard entry on the destination instead of
        // pushing on top of it, so leaving adds no extra history entry.
        event.preventDefault();
        event.stopPropagation();
        selfWriteRef.current = true;
        window.history.replaceState(null, '', destination.href);
        selfWriteRef.current = false;
      } else {
        // Let the router navigate, without asking a second time.
        confirmedLeaveRef.current = true;
        queueMicrotask(() => {
          confirmedLeaveRef.current = false;
        });
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
