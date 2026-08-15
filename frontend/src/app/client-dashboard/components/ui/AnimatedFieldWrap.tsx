/**
 * AnimatedFieldWrap
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in replacement for FieldWrap that adds:
 *   • Staggered entrance animation (mount fade-up via useFieldAnimation)
 *   • Hover lift + glow on the wrapper  (.wf-wrap CSS class)
 *   • Enhanced focus ring + scale on inputs/selects inside (.wf-field CSS class)
 *
 * Usage — identical to FieldWrap, just add `index`:
 *   <AnimatedFieldWrap label="Org Name" index={0}>
 *     <input ... className="wf-field" style={S.input} />
 *   </AnimatedFieldWrap>
 *
 * CSS classes injected by WizardGlobalStyles (no inline JS for hover):
 *   .wf-wrap   — the wrapper div; gets hover lift + transition
 *   .wf-field  — any input/select/textarea inside; gets focus/hover glow
 *
 * The `index` prop controls stagger delay. Pass the field's zero-based
 * position in the form so fields animate in top-to-bottom sequence.
 */

import React from "react";
import { C } from "../../pages/onboarding/shared/wizardTheme";
import { useFieldAnimation } from "../../hooks/useFormAnimation";

interface AnimatedFieldWrapProps {
  label: string;
  /** Zero-based position — drives stagger delay. */
  index: number;
  children: React.ReactNode;
}

const AnimatedFieldWrap: React.FC<AnimatedFieldWrapProps> = ({
  label,
  index,
  children,
}) => {
  const { ref, style } = useFieldAnimation(index);

  return (
    <div ref={ref} style={style} className="wf-wrap">
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          color: C.primaryDark,
          marginBottom: 6,
          transition: "color .18s ease",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
};

export default AnimatedFieldWrap;
