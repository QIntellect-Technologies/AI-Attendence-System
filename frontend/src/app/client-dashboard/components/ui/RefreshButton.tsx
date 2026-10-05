import React from "react";
import JellyButton from "./JellyButton";
import { RefreshCcw } from "lucide-react";

interface Props {
  onClick: () => void | Promise<void>;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  ariaLabel?: string;
  className?: string;
  /** Render as icon-only square button */
  iconOnly?: boolean;
  /** Expand to container width */
  fullWidth?: boolean;
}

const RefreshButton: React.FC<Props> = ({
  onClick,
  loading = false,
  size = "md",
  variant = "secondary",
  ariaLabel = "Refresh",
  className,
  iconOnly = false,
  fullWidth = false,
}) => {
  return (
    <JellyButton
      type="button"
      variant={variant}
      size={size}
      leftIcon={<RefreshCcw />}
      onClick={onClick}
      loading={loading}
      aria-label={ariaLabel}
      className={className}
      iconOnly={iconOnly}
      fullWidth={fullWidth}
    >
      {!iconOnly && (loading ? "Refreshing..." : "Refresh")}
    </JellyButton>
  );
};

export default RefreshButton;
