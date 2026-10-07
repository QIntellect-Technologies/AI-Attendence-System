import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

import {
  humanizeError,
  localNodeApi,
  type LiveAttendanceEvent,
} from "../api/localNodeApi";
import { DetectionCard } from "./LiveAttendancePanel";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AllDetectionModal({ open, onClose }: Props) {
  const [events, setEvents] = useState<LiveAttendanceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);
    localNodeApi
      .liveEvents(true)
      .then((response) => {
        if (!cancelled) setEvents(response.events);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(humanizeError(err, "Failed to load today's detections."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      style={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="all-detections-title"
        aria-modal="true"
        role="dialog"
        style={styles.modal}
      >
        <header style={styles.header}>
          <div>
            <h2 id="all-detections-title" style={styles.title}>
              All today&apos;s detections
            </h2>
            <p style={styles.subtitle}>
              {loading ? "Loading detections…" : `${events.length} detection${events.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close all detections"
            onClick={onClose}
            style={styles.closeButton}
          >
            <X size={18} />
          </button>
        </header>

        <div style={styles.content}>
          {loading ? (
            <div style={styles.state}>
              <Loader2 size={24} className="spin" />
              <span>Loading detections…</span>
            </div>
          ) : error ? (
            <div role="alert" style={styles.error}>
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : events.length === 0 ? (
            <div style={styles.state}>No detections recorded today.</div>
          ) : (
            <div style={styles.list}>
              {events.map((event) => (
                <DetectionCard
                  key={event.id}
                  event={event}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    display: "grid",
    placeItems: "center",
    padding: 20,
    background: "rgba(15, 23, 42, 0.5)",
  },
  modal: {
    width: "min(680px, 100%)",
    maxHeight: "min(85vh, 900px)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    background: "#fff",
    boxShadow: "0 24px 70px rgba(15, 23, 42, 0.25)",
  },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "18px 20px",
    borderBottom: "1px solid #e2e8f0",
  },
  title: {
    margin: 0,
    color: "#0f172a",
    fontSize: 18,
    fontWeight: 800,
  },
  subtitle: {
    margin: "4px 0 0",
    color: "#64748b",
    fontSize: 13,
  },
  closeButton: {
    display: "grid",
    placeItems: "center",
    width: 34,
    height: 34,
    flexShrink: 0,
    border: "1px solid #e2e8f0",
    borderRadius: 9,
    background: "#fff",
    color: "#475569",
    cursor: "pointer",
  },
  content: {
    minHeight: 180,
    overflowY: "auto",
    padding: 16,
  },
  list: {
    display: "grid",
    gap: 12,
    alignContent: "start",
  },
  state: {
    minHeight: 180,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    color: "#64748b",
    fontSize: 14,
    fontWeight: 600,
  },
  error: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: 12,
    border: "1px solid #fecaca",
    borderRadius: 10,
    background: "#fef2f2",
    color: "#b91c1c",
    fontSize: 13,
  },
};
