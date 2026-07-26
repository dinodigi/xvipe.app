/**
 * The door. Phase 1's real entry is the "Build & deploy" button inside a
 * Pluggie project (a link into /studio/<projectId>); this page is the dev
 * stand-in and the seam where Phase 2's standalone front door will land.
 * Keep the entry point swappable — XVIBE-PLAN's load-bearing rule.
 */
import { getDevProjectId } from "@/lib/pluggie/token";
import { DoorForm } from "@/components/DoorForm";

export default function Door() {
  const devProjectId = getDevProjectId();
  return (
    <main className="door">
      <div className="door-card">
        <div className="door-brand">
          <span className="x">X</span>Vibe
        </div>
        <p className="door-sub">
          Describe an app in chat. The builder defines its backend on Pluggie, generates a static
          frontend, and ships it to a live URL. You operate no runtime.
        </p>
        <div className="door-panel">
          <label className="door-label" htmlFor="door-project">
            Pluggie project
          </label>
          <DoorForm defaultProjectId={devProjectId} />
          <p className="door-note">
            Phase 1 opens from inside a Pluggie project — the <code>Build &amp; deploy</code> button
            lands here with the project preselected. This dev door uses{" "}
            <code>PLUGGIE_PROJECT_ID</code> from <code>.env.local</code>.
          </p>
        </div>
        <div className="door-foot">
          <span>backend · Pluggie</span>
          <span>deploys · R2 + CDN</span>
          <span>runtime · the visitor&apos;s browser</span>
        </div>
      </div>
    </main>
  );
}
