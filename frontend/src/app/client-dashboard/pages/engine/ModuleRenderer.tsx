import React, { Suspense } from "react";
import { getModule } from "../../config/moduleRegistry";
import { LoadingSkeleton } from "./ModuleShell";
import { T } from "../../components/ui/theme";

interface ModuleRendererProps {
  moduleKey: string;
}

const ModuleRenderer: React.FC<ModuleRendererProps> = ({ moduleKey }) => {
  const def = getModule(moduleKey);

  if (!def) {
    return (
      <div
        style={{
          padding: "60px 0",
          textAlign: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔧</div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: T.head,
            marginBottom: 6,
          }}
        >
          Module not found
        </div>
        <div style={{ fontSize: 13, color: T.muted }}>
          "{moduleKey}" is not registered in the module registry.
        </div>
      </div>
    );
  }

  const Component = def.Component;

  return (
    <Suspense
      fallback={
        <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: T.teal100,
              }}
            />
            <div
              style={{
                width: 160,
                height: 22,
                borderRadius: 6,
                background: T.teal100,
              }}
            />
          </div>
          <LoadingSkeleton rows={10} />
        </div>
      }
    >
      <Component />
    </Suspense>
  );
};

export default ModuleRenderer;
