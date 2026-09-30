import React from "react";
import { T } from "./theme";
import { useAuthenticatedImageUrl } from "../../hooks/useAuthenticatedImageUrl";

export interface AvatarProps {
  /** Image URL (authenticated photo routes are resolved automatically). */
  src?: string | null;
  /** Used for the initial fallback and the <img> alt text. */
  label: string;
  size?: number;
  /** "circle" for people, "rounded" for organization logos. */
  shape?: "circle" | "rounded";
  fit?: "cover" | "contain";
  /** Rendered instead of the initial when there is no image. */
  fallback?: React.ReactNode;
}

/**
 * Single avatar/logo primitive shared by the header chips, the My Account
 * button and the My Account profile card, so photo loading, sizing and the
 * initial fallback are defined once.
 */
export const Avatar: React.FC<AvatarProps> = ({
  src,
  label,
  size = 36,
  shape = "circle",
  fit = "cover",
  fallback,
}) => {
  // Photo routes need an Authorization header a plain <img src> can't send.
  const photoSrc = useAuthenticatedImageUrl(src || null);
  const initial = label.trim().charAt(0).toUpperCase() || "A";
  const isLogo = shape === "rounded";

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: isLogo ? 8 : "50%",
        background: isLogo ? "#fff" : T.teal100,
        color: T.teal700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 900,
        fontSize: Math.max(11, Math.round(size * 0.36)),
        overflow: "hidden",
        flexShrink: 0,
        boxSizing: "border-box",
      }}
    >
      {photoSrc ? (
        <img
          src={photoSrc}
          alt={label}
          style={{ width: "100%", height: "100%", objectFit: fit }}
        />
      ) : (
        (fallback ?? initial)
      )}
    </div>
  );
};

export default Avatar;
