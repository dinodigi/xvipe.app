/**
 * /unlock — the studio's access gate (shown by middleware when
 * STUDIO_ACCESS_KEY is set and the visitor hasn't presented it).
 * Submitting navigates to /?key=… ; middleware validates, sets the cookie,
 * and redirects clean. Built apps are never gated — only the studio.
 */
export default function Unlock() {
  return (
    <main className="door">
      <div className="door-card">
        <div className="door-brand">
          <span className="x">X</span>Vibe
        </div>
        <p className="door-sub">This studio is private — builds run on the operator&apos;s API credits.</p>
        <form className="door-panel" action="/" method="get">
          <label className="door-label" htmlFor="unlock-key">
            Access key
          </label>
          <div className="door-row">
            <input id="unlock-key" name="key" type="password" className="door-input" autoFocus />
            <button className="btn primary" type="submit">
              Enter
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
