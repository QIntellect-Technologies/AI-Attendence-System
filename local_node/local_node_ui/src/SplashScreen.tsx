import React, { useEffect, useRef } from "react";
import logo from "./assets/qintellect-logo.png";

/**
 * "Quantum Intelligence Activation" splash: three particles converge from
 * different directions -> a faint neural-network mesh forms -> a scan line
 * sweeps through -> orbit rings spin around center -> the QIntellect logo
 * materializes from the convergence -> wordmark + tagline reveal ->
 * AI • QUANTUM signature -> settles and fades into the app.
 *
 * Pure white background per brand direction. CSS-keyframe only (no
 * animation library in package.json) — everything animates transform/
 * opacity so it stays cheap even with this many moving pieces.
 */

const TOTAL_MS = 4200;
const FADE_OUT_MS = 380;

interface SplashScreenProps {
  orgName: string;
  productName?: string;
  onFinish: () => void;
}

export default function SplashScreen({ onFinish }: SplashScreenProps) {
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const duration = prefersReducedMotion ? 1000 : TOTAL_MS + FADE_OUT_MS;
    const timer = window.setTimeout(() => onFinishRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="qia-splash-overlay"
      style={styles.overlay}
      role="status"
      aria-label="Starting QIntellect"
    >
      <style>{CSS}</style>
      <div className="qia-scene">
        <svg
          className="qia-svg"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="qiaGlow">
              <stop offset="0" stopColor="#17a5c4" stopOpacity="0.28" />
              <stop offset="1" stopColor="#17a5c4" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle
            cx="500"
            cy="470"
            r="220"
            fill="url(#qiaGlow)"
            opacity="0.35"
          />
          <g transform="translate(500 470)">
            <ellipse className="qia-ring qia-r1" rx="145" ry="62" />
            <ellipse
              className="qia-ring qia-r2"
              rx="122"
              ry="46"
              transform="rotate(58)"
            />
            <ellipse
              className="qia-ring qia-r3"
              rx="165"
              ry="80"
              transform="rotate(-28)"
            />
          </g>
          <g className="qia-neural">
            <g className="qia-link">
              <line x1="240" y1="390" x2="355" y2="450" />
              <line x1="240" y1="390" x2="335" y2="540" />
              <line x1="760" y1="400" x2="645" y2="450" />
              <line x1="760" y1="400" x2="665" y2="535" />
              <line x1="335" y1="540" x2="500" y2="470" />
              <line x1="665" y1="535" x2="500" y2="470" />
            </g>
            <circle className="qia-node" cx="240" cy="390" r="4" />
            <circle className="qia-node" cx="760" cy="400" r="4" />
            <circle className="qia-node" cx="335" cy="540" r="3" />
            <circle className="qia-node" cx="665" cy="535" r="3" />
            <circle className="qia-node" cx="500" cy="470" r="6" />
          </g>
        </svg>

        <span className="qia-flash qia-f1" />
        <span className="qia-flash qia-f2" />
        <span className="qia-flash qia-f3" />
        <span className="qia-scan" />

        <img className="qia-logo" src={logo} alt="QIntellect" />

        <div className="qia-word">
          <div className="qia-name">QIntellect Technologies</div>
          <div className="qia-tag">
            Driving The Future Of Technology, Powered By Quantum And AI
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "#ffffff",
    overflow: "hidden",
  },
};

const CSS = `
  .qia-scene {
    position: relative;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    isolation: isolate;
    font-family: Inter, system-ui, sans-serif;
  }
  .qia-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  .qia-ring {
    fill: none;
    stroke-linecap: round;
    transform-origin: center;
    transform-box: fill-box;
  }
  .qia-r1 { stroke: #12518c; stroke-width: 2.5; stroke-dasharray: 10 18; animation: qia-spin 3s linear infinite; }
  .qia-r2 { stroke: #17a5c4; stroke-width: 1.8; stroke-dasharray: 4 15; animation: qia-spin-rev 2.2s linear infinite; }
  .qia-r3 { stroke: #9fdbe8; stroke-width: 1; stroke-dasharray: 2 12; animation: qia-spin 4.5s linear infinite reverse; }

  .qia-neural { opacity: 0; animation: qia-neural-in 0.8s ease 0.95s forwards; }
  .qia-node { fill: #17a5c4; }
  .qia-link line { stroke: #6fd0e2; stroke-width: 1; opacity: 0.45; }

  .qia-scan {
    position: absolute;
    z-index: 7;
    left: 18%;
    right: 18%;
    height: 1px;
    top: 50%;
    background: linear-gradient(90deg, transparent, #17a5c4, transparent);
    opacity: 0;
    animation: qia-scan-move 1.1s ease 0.7s forwards;
  }

  .qia-flash {
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #17a5c4;
    box-shadow: 0 0 15px #17a5c4, 0 0 45px rgba(23, 165, 196, 0.6);
    z-index: 3;
    opacity: 0;
  }
  .qia-f1 { animation: qia-travel-1 1.15s cubic-bezier(0.3, 0.8, 0.3, 1) 0.05s forwards; }
  .qia-f2 { animation: qia-travel-2 1.2s cubic-bezier(0.3, 0.8, 0.3, 1) 0.22s forwards; }
  .qia-f3 { animation: qia-travel-3 1.05s cubic-bezier(0.3, 0.8, 0.3, 1) 0.35s forwards; }

  .qia-logo {
    position: absolute;
    width: min(42vw, 260px);
    max-width: 260px;
    z-index: 4;
    opacity: 0;
    filter: drop-shadow(0 8px 22px rgba(6, 38, 79, 0.12)) blur(8px);
    animation: qia-logo-in 0.75s cubic-bezier(0.2, 0.9, 0.2, 1) 0.72s forwards,
      qia-logo-pulse 1.8s ease-in-out 1.65s infinite;
  }

  .qia-word {
    position: absolute;
    z-index: 5;
    top: calc(50% + 165px);
    text-align: center;
    color: #12518c;
    opacity: 0;
    animation: qia-words-in 0.65s ease 1.48s forwards;
    padding: 0 24px;
  }
  .qia-name { font-size: clamp(20px, 3.4vw, 28px); font-weight: 800; letter-spacing: -0.01em; color: #06264f; }
  .qia-tag {
    margin-top: 10px;
    font-size: clamp(12px, 1.6vw, 15px);
    letter-spacing: 0.01em;
    color: #17a5c4;
    font-weight: 700;
    max-width: 420px;
  }

  .qia-splash-overlay {
    animation: qia-overlay-fade-out ${FADE_OUT_MS}ms ease-in ${TOTAL_MS / 1000}s forwards;
    pointer-events: none;
  }

  @keyframes qia-logo-in {
    0% { opacity: 0; transform: scale(0.58) rotate(-8deg); filter: blur(8px); }
    65% { opacity: 1; transform: scale(1.05) rotate(1deg); filter: blur(0); }
    100% { opacity: 1; transform: scale(1) rotate(0deg); filter: blur(0); }
  }
  @keyframes qia-logo-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
  }
  @keyframes qia-words-in {
    from { opacity: 0; transform: translateY(16px); filter: blur(4px); }
    to { opacity: 1; transform: none; filter: none; }
  }
  @keyframes qia-neural-in {
    from { opacity: 0; transform: scale(0.5); }
    to { opacity: 0.8; transform: scale(1); }
  }
  @keyframes qia-scan-move {
    0% { opacity: 0; transform: scaleX(0); }
    20% { opacity: 0.8; }
    100% { opacity: 0; transform: scaleX(1); }
  }
  @keyframes qia-spin { to { transform: rotate(360deg); } }
  @keyframes qia-spin-rev { to { transform: rotate(-360deg); } }

  @keyframes qia-travel-1 {
    0% { opacity: 0; left: 12%; top: 24%; transform: scale(0.3); }
    15% { opacity: 1; }
    100% { opacity: 0; left: 50%; top: 50%; transform: scale(1.3); }
  }
  @keyframes qia-travel-2 {
    0% { opacity: 0; left: 86%; top: 33%; transform: scale(0.3); }
    18% { opacity: 1; }
    100% { opacity: 0; left: 50%; top: 50%; transform: scale(1.1); }
  }
  @keyframes qia-travel-3 {
    0% { opacity: 0; left: 16%; top: 76%; transform: scale(0.25); }
    20% { opacity: 1; }
    100% { opacity: 0; left: 50%; top: 50%; transform: scale(1.5); }
  }

  @keyframes qia-overlay-fade-out { to { opacity: 0; } }

  @media (max-width: 600px) {
    .qia-logo { width: 56vw; }
    .qia-word { top: calc(50% + 130px); }
    .qia-tag { letter-spacing: 0; padding: 0 12px; }
    .qia-scan { left: 8%; right: 8%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .qia-logo, .qia-word, .qia-neural, .qia-flash, .qia-scan {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
      filter: none !important;
    }
    .qia-splash-overlay { animation: qia-overlay-fade-out 350ms ease-in 550ms forwards; }
  }
`;
