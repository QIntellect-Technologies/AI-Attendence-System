/**
 * useFormAnimation
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable animation hook for wizard form fields.
 *
 * Provides:
 *   useFieldAnimation(index)  — single field entrance + interaction styles
 *   useFormAnimation(count)   — convenience wrapper for N fields at once
 *
 * Entrance: translateY(14px) → 0 + opacity 0 → 1, staggered by index × 65ms.
 * Triggered once on mount via requestAnimationFrame (no IntersectionObserver
 * needed — wizard steps always start in-viewport).
 *
 * Interaction (hover/focus/active) is handled entirely in CSS via the
 * `.wf-wrap` and `.wf-field` classes injected by WizardGlobalStyles so no
 * per-field JS state is needed.
 */

import { useEffect, useRef, useState } from "react";
import type React from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Delay between each field's entrance, in ms. */
const STAGGER_MS = 65;

/** Duration of the entrance transition, in ms. */
const DURATION_MS = 380;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FieldAnimationResult {
  /**
   * Attach to the outermost wrapper div of the field group.
   * React DOM refs are nullable before mount and after unmount, so the public
   * contract must include `null` instead of pretending the element always exists.
   */
  ref: React.RefObject<HTMLDivElement | null>;

  /**
   * Merge into the wrapper div's `style` prop.
   * Contains the initial (hidden) state; the hook transitions to visible.
   */
  style: React.CSSProperties;
}

function entranceStyle(ready: boolean, index: number): React.CSSProperties {
  return {
    opacity: ready ? 1 : 0,
    transform: ready ? "translateY(0)" : "translateY(14px)",
    transition: `opacity ${DURATION_MS}ms ease, transform ${DURATION_MS}ms ease`,
    transitionDelay: `${index * STAGGER_MS}ms`,
    // Ensure transforms don't clip child box-shadows.
    willChange: "opacity, transform",
  };
}

function useEntranceReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let id2 = 0;

    // Double-rAF: first frame commits initial styles to the DOM,
    // second frame starts the transition so the browser sees the diff.
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setReady(true));
    });

    return () => {
      cancelAnimationFrame(id1);
      if (id2) cancelAnimationFrame(id2);
    };
  }, []);

  return ready;
}

// ─── useFieldAnimation ────────────────────────────────────────────────────────

/**
 * Animates a single form field wrapper into view on mount.
 *
 * @param index  Zero-based position in the form — controls stagger delay.
 */
export function useFieldAnimation(index: number): FieldAnimationResult {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useEntranceReady();

  return {
    ref,
    style: entranceStyle(ready, index),
  };
}

// ─── useFormAnimation ─────────────────────────────────────────────────────────

/**
 * Convenience hook that returns animation props for `count` fields at once.
 *
 * Usage:
 *   const fields = useFormAnimation(5);
 *   // fields[0].ref, fields[0].style → first field
 *   // fields[1].ref, fields[1].style → second field
 */
export function useFormAnimation(count: number): FieldAnimationResult[] {
  // Stable array length: hooks cannot be called conditionally, so we
  // pre-create refs for a fixed max and slice to `count`.
  // Max supported: 12 fields per form step.
  const MAX = 12;
  const safeCount = Math.max(0, Math.min(count, MAX));

  // One ref per slot — always created, never conditionally called.
  const refs: Array<React.RefObject<HTMLDivElement | null>> = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ];

  const ready = useEntranceReady();

  return refs.slice(0, safeCount).map((ref, index) => ({
    ref,
    style: entranceStyle(ready, index),
  }));
}
