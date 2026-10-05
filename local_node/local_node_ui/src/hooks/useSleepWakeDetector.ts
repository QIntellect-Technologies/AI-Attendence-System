import { useEffect, useRef } from "react";

/**
 * Detects "this machine just came back from sleep/suspend" in a plain
 * browser tab (no Electron/OS-level hook available here — main.py just
 * opens a normal tab via webbrowser.open()).
 *
 * How it works: a steady heartbeat interval stamps `lastTickRef` on every
 * tick. While the OS is suspended, ALL JS timers in the tab are frozen —
 * so the very next tick after resume fires with a wall-clock gap far
 * larger than `tickMs`. That drift is the actual signal; it's the standard
 * client-side proxy for "the machine was asleep," since there's no direct
 * suspend/resume event exposed to a web page.
 *
 * Gated on `document.hidden` (tracked via `visibilitychange`, not read at
 * fire-time) so ordinary foreground use never trips it: ordinary tab
 * switching/minimizing does throttle background timers, but ONLY while
 * hidden, which is exactly the case we want to allow through — actual
 * sleep always happens while the tab is backgrounded or the screen is
 * locked. A large gap on a tab that was never hidden (e.g. a debugger
 * breakpoint) is deliberately ignored.
 *
 * `visibilitychange` is also checked directly (not just the heartbeat) so
 * detection fires the moment the tab regains visibility, rather than
 * waiting up to `tickMs` for the next heartbeat.
 */
export function useSleepWakeDetector(
  onWake: () => void,
  options?: { thresholdMs?: number; tickMs?: number },
): void {
  const thresholdMs = options?.thresholdMs ?? 25_000;
  const tickMs = options?.tickMs ?? 2_000;

  // Ref, not state — this fires on a timer/event, not a render, and
  // doesn't need to trigger one itself.
  const lastTickRef = useRef(Date.now());
  const wasHiddenRef = useRef(document.hidden);

  // Keep the latest callback without re-subscribing the interval/listener
  // on every parent re-render (App re-renders every 3s on its own status
  // poll, and onWake is typically an inline arrow function there).
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  useEffect(() => {
    const checkGapAndFire = () => {
      const now = Date.now();
      const gap = now - lastTickRef.current;
      if (gap > thresholdMs && wasHiddenRef.current) {
        onWakeRef.current();
      }
      lastTickRef.current = now;
    };

    const heartbeat = window.setInterval(checkGapAndFire, tickMs);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        wasHiddenRef.current = true;
        return;
      }
      checkGapAndFire();
      wasHiddenRef.current = false;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [thresholdMs, tickMs]);
}
