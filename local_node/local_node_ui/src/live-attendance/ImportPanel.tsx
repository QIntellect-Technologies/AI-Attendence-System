import React, { useState } from "react";
import {
  UploadCloud,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  localNodeApi,
  humanizeError,
  type ImportEmbeddingsResult,
} from "../api/localNodeApi";

export default function ImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportEmbeddingsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await localNodeApi.importEmbeddings(file);
      setResult(outcome);
      setFile(null);
    } catch (err) {
      setError(humanizeError(err, "Import failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section style={styles.card}>
        <h2 style={styles.title}>Import enrollment package</h2>
        <p style={styles.helper}>
          Select the <code>import_package.zip</code> produced by the training
          workstation. New and re-trained people are added; everyone else
          already on this node is left untouched.
        </p>
        <input
          type="file"
          accept=".zip"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          style={styles.input}
        />
        <button
          type="button"
          style={styles.button}
          onClick={runImport}
          disabled={!file || busy}
        >
          {busy ? <Loader2 size={15} /> : <UploadCloud size={15} />}
          Import package
        </button>

        {error && (
          <div style={styles.error}>
            <AlertTriangle size={16} /> {error}
          </div>
        )}

        {result && (
          <div style={styles.result}>
            <div style={styles.resultHeader}>
              <CheckCircle2 size={18} color="#0d9488" />
              <strong>Branch: {result.branch_label || "unlabeled"}</strong>
            </div>
            <p style={styles.resultLine}>
              Imported {result.imported} · Skipped {result.skipped} · Generated{" "}
              {result.generated_at}
            </p>
            {result.errors.length > 0 && (
              <ul style={styles.errorList}>
                {result.errors.map((line: string) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <p style={styles.confirmPrompt}>
              Confirm the branch name above matches this machine before relying
              on this import.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid #dbe7ef",
    borderRadius: 18,
    padding: 20,
    background: "#f8fbfd",
    marginBottom: 20,
  },
  title: { margin: "0 0 8px", color: "#12385a", fontSize: 16 },
  helper: {
    margin: "0 0 14px",
    color: "#64748b",
    fontSize: 13,
    lineHeight: 1.6,
  },
  input: { display: "block", marginBottom: 12 },
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    border: 0,
    borderRadius: 10,
    background: "#0d9488",
    color: "#fff",
    padding: "9px 14px",
    fontWeight: 800,
    cursor: "pointer",
  },
  error: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    color: "#be123c",
    fontSize: 13,
    fontWeight: 700,
  },
  result: { marginTop: 14, borderTop: "1px solid #dbe7ef", paddingTop: 12 },
  resultHeader: { display: "flex", alignItems: "center", gap: 8 },
  resultLine: { margin: "6px 0 0", color: "#334155", fontSize: 13 },
  errorList: {
    margin: "8px 0 0",
    paddingLeft: 18,
    color: "#c2410c",
    fontSize: 12,
  },
  confirmPrompt: {
    margin: "10px 0 0",
    color: "#92400e",
    fontSize: 12,
    fontWeight: 700,
  },
};
