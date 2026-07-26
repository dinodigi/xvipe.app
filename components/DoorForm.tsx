"use client";

import { useState } from "react";

export function DoorForm({ defaultProjectId }: { defaultProjectId?: string }) {
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const open = () => {
    const id = projectId.trim();
    if (id) window.location.href = `/studio/${encodeURIComponent(id)}`;
  };
  return (
    <div className="door-row">
      <input
        id="door-project"
        className="door-input"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && open()}
        placeholder="project id (uuid)"
        spellCheck={false}
      />
      <button className="btn primary" onClick={open} disabled={!projectId.trim()}>
        Open studio
      </button>
    </div>
  );
}
