/**
 * lib/apps/reserved.ts — subdomains an app slug may never claim.
 *
 * Apps live at <slug>.<domain>, so every app slug permanently consumes a
 * subdomain of the product's own namespace. Reserving a name costs nothing
 * today; reclaiming one after a user's app is live on it costs them a URL.
 * Squat generously.
 *
 * The edge worker keeps its own copy (workers/edge/src/worker.js) because it
 * runs in a separate runtime — keep the two in sync.
 */
export const RESERVED_SLUGS = new Set([
  // the product surface
  "www", "studio", "api", "admin", "unlock", "apps", "app", "dashboard", "console",
  // identity + billing
  "account", "accounts", "login", "signup", "signin", "auth", "oauth", "sso",
  "billing", "invoice", "invoices", "pay", "payments", "checkout",
  // content + marketing
  "blog", "docs", "doc", "help", "support", "status", "about", "pricing",
  "careers", "jobs", "press", "news", "changelog", "roadmap",
  // legal
  "legal", "terms", "privacy", "security", "trust", "abuse", "dmca",
  // infrastructure
  "cdn", "assets", "static", "media", "files", "img", "images", "download",
  "mail", "smtp", "imap", "email", "ns", "ns1", "ns2", "dns", "mx",
  "health", "metrics", "monitor", "logs", "grafana",
  // environments
  "dev", "staging", "stage", "test", "testing", "qa", "sandbox", "demo",
  "preview", "beta", "alpha", "next", "edge", "local",
]);

/** Reserved, or structurally invalid as a hostname label. */
export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug.toLowerCase());
