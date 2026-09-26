import React, { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { T } from "./theme";

const SPIN_KEYFRAMES_ID = "app-spin-keyframes";
const SPIN_ANIMATION_NAME = "app-spin";

function useSpinKeyframes() {
  useEffect(() => {
    if (document.getElementById(SPIN_KEYFRAMES_ID)) return;
    const style = document.createElement("style");
    style.id = SPIN_KEYFRAMES_ID;
    style.textContent = `@keyframes ${SPIN_ANIMATION_NAME} { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }, []);
}

export const Spinner: React.FC<{ size?: number; color?: string }> = ({
  size = 14,
  color = T.muted,
}) => {
  useSpinKeyframes();
  return (
    <Loader2
      size={size}
      color={color}
      style={{ animation: `${SPIN_ANIMATION_NAME} 0.8s linear infinite` }}
    />
  );
};

export default Spinner;