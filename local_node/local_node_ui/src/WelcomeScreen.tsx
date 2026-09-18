import React, { useEffect, useRef } from "react";
import logo from "./assets/qintellect-logo.png";

/**
 * One-shot overlay shown right after a successful node activation, before
 * the operator lands on the main console. White background to match the
 * splash screen's brand direction.
 *
 * Layout: an "atom" style background — three crossing elliptical orbit
 * rings with small spheres traveling along them, plus a soft central glow
 * — sits full-screen at low opacity as a decorative backdrop. The logo and
 * text stack sit in a separate layer, centered at the exact same screen
 * point the rings converge on, so the logo reads as sitting inside the
 * rings rather than overlapping their edge.
 *
 * CSS-keyframe + SMIL (animateMotion) only — no animation library in
 * package.json.
 */

const AUTO_DISMISS_MS = 4200;
const FADE_OUT_MS = 380;

interface WelcomeScreenProps {
  orgName: string;
  onFinish: () => void;
}

export default function WelcomeScreen({
  orgName,
  onFinish,
}: WelcomeScreenProps) {
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  useEffect(() => {
    const timer = window.setTimeout(
      () => onFinishRef.current(),
      AUTO_DISMISS_MS + FADE_OUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="qia-welcome-overlay"
      style={styles.overlay}
      role="status"
      aria-label={`Welcome, ${orgName}`}
    >
      <style>{CSS}</style>
      <div className="qia-welcome-stage">
        {/* Background atom animation — low opacity, purely decorative */}
        <div className="qia-atom-bg" aria-hidden="true">
          <span className="qia-welcome-glow" />
          <svg
            className="qia-atom-svg"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="xMidYMid meet"
          >
            <g transform="translate(500 500)">
              <g transform="rotate(-18)">
                <ellipse className="qia-atom-ring" rx="340" ry="130" />
                <circle className="qia-atom-dot qia-dot-a" r="7">
                  <animateMotion
                    dur="7s"
                    repeatCount="indefinite"
                    path="M -340,0 A 340,130 0 1,0 340,0 A 340,130 0 1,0 -340,0 Z"
                  />
                </circle>
              </g>
              <g transform="rotate(35)">
                <ellipse className="qia-atom-ring" rx="300" ry="108" />
                <circle className="qia-atom-dot qia-dot-b" r="5.5">
                  <animateMotion
                    dur="5.5s"
                    repeatCount="indefinite"
                    path="M -300,0 A 300,108 0 1,1 300,0 A 300,108 0 1,1 -300,0 Z"
                  />
                </circle>
              </g>
              <g transform="rotate(82)">
                <ellipse className="qia-atom-ring" rx="265" ry="95" />
                <circle className="qia-atom-dot qia-dot-c" r="6">
                  <animateMotion
                    dur="9s"
                    repeatCount="indefinite"
                    path="M -265,0 A 265,95 0 1,0 265,0 A 265,95 0 1,0 -265,0 Z"
                  />
                </circle>
              </g>
            </g>
            <circle className="qia-atom-speck" cx="150" cy="230" r="4" />
            <circle className="qia-atom-speck" cx="840" cy="720" r="5" />
            <circle className="qia-atom-speck" cx="810" cy="260" r="3" />
            <circle className="qia-atom-speck" cx="190" cy="760" r="3.5" />
          </svg>
        </div>

        {/* Foreground content — centered at the same point as the atom */}
        <div className="qia-welcome-content">
          <img className="qia-welcome-logo" src={logo} alt="QIntellect" />
          <h1 className="qia-welcome-title">
            Welcome, <span className="qia-welcome-org">{orgName}</span>
          </h1>
          <p className="qia-welcome-sub">Your workspace is ready.</p>
          <span className="qia-welcome-footer">
            Powered by QIntellect Technologies
          </span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 9998,
    background: "#ffffff",
    overflow: "hidden",
  },
};

const CSS = `
  .qia-welcome-stage {
    position: relative;
    width: 100%;
    height: 100%;
    font-family: Inter, system-ui, sans-serif;
  }

  .qia-atom-bg {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 0;
    opacity: 0;
    animation: qia-atom-fade-in 1s ease-out 0.1s forwards;
  }

  .qia-atom-svg {
    width: min(120vw, 900px);
    height: min(120vw, 900px);
  }

  .qia-atom-ring {
    fill: none;
    stroke: #12518c;
    stroke-width: 1.4;
    opacity: 0.4;
  }

  .qia-atom-dot { opacity: 0.85; }
  .qia-dot-a { fill: #17a5c4; }
  .qia-dot-b { fill: #4fd3ea; }
  .qia-dot-c { fill: #12518c; }

  .qia-atom-speck {
    fill: #17a5c4;
    opacity: 0.55;
    animation: qia-spark-float 2.8s ease-in-out infinite;
  }
  .qia-atom-speck:nth-of-type(2) { animation-delay: 0.5s; }
  .qia-atom-speck:nth-of-type(3) { animation-delay: 0.9s; }
  .qia-atom-speck:nth-of-type(4) { animation-delay: 1.3s; }

  .qia-welcome-glow {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 240px;
    height: 240px;
    margin: -120px 0 0 -120px;
    border-radius: 50%;
    background: rgba(23, 165, 196, 0.22);
    filter: blur(22px);
    animation: qia-glow-pulse 2.6s ease-in-out infinite;
  }

  .qia-welcome-content {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .qia-welcome-logo {
    position: relative;
    width: 84px;
    height: auto;
    margin-bottom: 22px;
    filter: drop-shadow(0 8px 20px rgba(6, 38, 79, 0.15));
    opacity: 0;
    transform: scale(0.7);
    animation: qia-logo-pop 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards,
      qia-logo-breathe 3.4s ease-in-out 0.75s infinite;
  }

  .qia-welcome-title {
    margin: 0;
    color: #06264f;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.01em;
    opacity: 0;
    animation: qia-fade-up 0.5s ease-out 0.35s forwards;
  }
  .qia-welcome-org { color: #17a5c4; }

  .qia-welcome-sub {
    margin: 10px 0 0;
    color: #12518c;
    font-size: 15px;
    font-weight: 500;
    opacity: 0;
    animation: qia-fade-up 0.5s ease-out 0.47s forwards;
  }

  .qia-welcome-footer {
    margin-top: 22px;
    color: #6f93b8;
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    opacity: 0;
    animation: qia-fade-up 0.5s ease-out 0.59s forwards;
  }

  .qia-welcome-overlay {
    animation: qia-welcome-fade-out ${FADE_OUT_MS}ms ease-in ${AUTO_DISMISS_MS / 1000}s forwards;
  }

  @keyframes qia-atom-fade-in { to { opacity: 0.4; } }

  @keyframes qia-glow-pulse {
    0%, 100% { transform: scale(0.92); opacity: 0.7; }
    50% { transform: scale(1.14); opacity: 1; }
  }

  @keyframes qia-spark-float {
    0%, 100% { transform: translateY(0) scale(1); opacity: 0.4; }
    50% { transform: translateY(-10px) scale(1.3); opacity: 0.9; }
  }

  @keyframes qia-logo-pop { to { opacity: 1; transform: scale(1); } }
  @keyframes qia-logo-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.03); }
  }

  @keyframes qia-fade-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes qia-welcome-fade-out { to { opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .qia-welcome-logo, .qia-welcome-title, .qia-welcome-sub, .qia-welcome-footer,
    .qia-welcome-glow, .qia-atom-bg, .qia-atom-speck {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }
    .qia-atom-bg { opacity: 0.4 !important; }
  }
`;
