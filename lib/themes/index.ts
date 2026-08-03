/**
 * lib/themes/index.ts — design-token themes for generated apps.
 *
 * A theme is a small, fixed set of CSS custom properties written into the app
 * as `css/theme.css`. The agent styles against the token NAMES, never raw
 * hex — so switching a theme is a single file write: instant, free, and with
 * no model call. That is the whole point of the feature.
 *
 * Typefaces are system stacks on purpose. Generated apps ship self-contained
 * with no CDN, and a webfont request is a dependency that can fail; modern
 * systems already carry genuinely characterful faces (Palatino, Optima,
 * Futura, Baskerville) and reaching for those instead of defaulting to
 * system-ui everywhere is what keeps these from reading as the same template.
 *
 * These are deliberately NOT the three looks AI design converges on — warm
 * cream + high-contrast serif + terracotta, near-black + acid accent, or the
 * hairline-rule broadsheet. Each direction below is chosen for a domain XVibe
 * actually builds for.
 */

export interface ThemeTokens {
  /* colour */
  bg: string;
  surface: string;
  ink: string;
  inkSoft: string;
  line: string;
  accent: string;
  accentInk: string;
  ok: string;
  warn: string;
  danger: string;
  /* type */
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
  displayWeight: string;
  displayTracking: string;
  displayCase: string;
  /* form */
  radius: string;
  radiusLg: string;
  shadow: string;
}

export interface Theme {
  id: string;
  name: string;
  /** shown in the studio, and given to the agent so it can choose sensibly */
  suits: string;
  tokens: ThemeTokens;
}

const SANS_HUMANIST = `Candara, Optima, "Segoe UI", system-ui, sans-serif`;
const SANS_SYSTEM = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const SANS_GEOMETRIC = `Futura, "Century Gothic", "Trebuchet MS", system-ui, sans-serif`;
const SANS_FRIENDLY = `"Trebuchet MS", Verdana, system-ui, sans-serif`;
const SERIF_OLDSTYLE = `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`;
const SERIF_EDITORIAL = `Baskerville, "Hoefler Text", "Times New Roman", Georgia, serif`;
const MONO = `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`;

export const THEMES: Theme[] = [
  {
    id: "consultation",
    name: "Consultation",
    suits: "clinics, dentists, therapists, law and accountancy — calm authority, unhurried, high legibility",
    tokens: {
      bg: "#F4F7F5", surface: "#FFFFFF", ink: "#0E1F1B", inkSoft: "#4A5F59", line: "#D3DEDA",
      accent: "#123B33", accentInk: "#FFFFFF", ok: "#2F7D5B", warn: "#A67C2E", danger: "#9B3A31",
      fontDisplay: SERIF_OLDSTYLE, fontBody: SANS_HUMANIST, fontMono: MONO,
      displayWeight: "600", displayTracking: "-0.01em", displayCase: "none",
      radius: "6px", radiusLg: "12px", shadow: "0 1px 2px rgba(14,31,27,.06), 0 8px 24px rgba(14,31,27,.05)",
    },
  },
  {
    id: "storefront",
    name: "Storefront",
    suits: "barbers, salons, boutiques, cafés — confident and tactile, a little glamorous",
    tokens: {
      bg: "#FAF7F5", surface: "#FFFFFF", ink: "#241826", inkSoft: "#6B5A6E", line: "#E4D9E2",
      accent: "#3B1F3B", accentInk: "#F5E6E8", ok: "#4F7A54", warn: "#C08A2E", danger: "#A33B48",
      fontDisplay: SANS_GEOMETRIC, fontBody: SANS_SYSTEM, fontMono: MONO,
      displayWeight: "700", displayTracking: "0.08em", displayCase: "uppercase",
      radius: "2px", radiusLg: "4px", shadow: "0 2px 0 #3B1F3B",
    },
  },
  {
    id: "console",
    name: "Console",
    suits: "internal tools, support desks, admin panels, dashboards — dense, functional, data-forward",
    tokens: {
      bg: "#F7F8FA", surface: "#FFFFFF", ink: "#1F2933", inkSoft: "#5B6B7B", line: "#D9DEE5",
      accent: "#2C5F8A", accentInk: "#FFFFFF", ok: "#2F7D5B", warn: "#B4592A", danger: "#B02A37",
      fontDisplay: SANS_SYSTEM, fontBody: SANS_SYSTEM, fontMono: MONO,
      displayWeight: "600", displayTracking: "-0.005em", displayCase: "none",
      radius: "4px", radiusLg: "6px", shadow: "0 1px 2px rgba(31,41,51,.08)",
    },
  },
  {
    id: "field",
    name: "Field",
    suits: "plumbers, roofers, landscapers, contractors — rugged and high-contrast, readable on a phone in daylight",
    tokens: {
      bg: "#E9EBE8", surface: "#FFFFFF", ink: "#22262B", inkSoft: "#525A62", line: "#C4C9C3",
      accent: "#F2B705", accentInk: "#22262B", ok: "#3C7A4B", warn: "#C2610F", danger: "#A32B25",
      fontDisplay: SANS_SYSTEM, fontBody: SANS_SYSTEM, fontMono: MONO,
      displayWeight: "800", displayTracking: "-0.02em", displayCase: "uppercase",
      radius: "0px", radiusLg: "2px", shadow: "0 4px 0 rgba(34,38,43,.9)",
    },
  },
  {
    id: "studio",
    name: "Studio",
    suits: "photographers, designers, weddings, portfolios — quiet and editorial, images carry the page",
    tokens: {
      bg: "#EFEFEC", surface: "#FFFFFF", ink: "#1C1C1A", inkSoft: "#6E6E68", line: "#DBDBD5",
      accent: "#4A3F55", accentInk: "#F6F5F2", ok: "#5E7F63", warn: "#96712F", danger: "#8C3A38",
      fontDisplay: SERIF_EDITORIAL, fontBody: SANS_HUMANIST, fontMono: MONO,
      displayWeight: "400", displayTracking: "-0.03em", displayCase: "none",
      radius: "0px", radiusLg: "0px", shadow: "none",
    },
  },
  {
    id: "commons",
    name: "Commons",
    suits: "clubs, schools, nonprofits, events, guestbooks — friendly and open without being childish",
    tokens: {
      bg: "#FFFDF9", surface: "#FFFFFF", ink: "#1F2430", inkSoft: "#5A6273", line: "#E3E2DA",
      accent: "#3E7CB1", accentInk: "#FFFFFF", ok: "#5C9A6B", warn: "#D19A2E", danger: "#B3564B",
      fontDisplay: SANS_FRIENDLY, fontBody: SANS_SYSTEM, fontMono: MONO,
      displayWeight: "700", displayTracking: "-0.01em", displayCase: "none",
      radius: "12px", radiusLg: "20px", shadow: "0 2px 4px rgba(31,36,48,.06), 0 12px 28px rgba(31,36,48,.07)",
    },
  },
];

export const DEFAULT_THEME_ID = "console";
export const getTheme = (id: string): Theme | undefined => THEMES.find((t) => t.id === id);

/** The file the agent links, and the only place raw colour values appear. */
export const THEME_FILE = "css/theme.css";

export function renderThemeCss(theme: Theme): string {
  const t = theme.tokens;
  return `/* XVibe theme: ${theme.name} — ${theme.suits}
   Generated file. Style against the token names below; changing the theme
   rewrites only this file, so never hard-code a colour anywhere else. */
:root {
  --bg: ${t.bg};
  --surface: ${t.surface};
  --ink: ${t.ink};
  --ink-soft: ${t.inkSoft};
  --line: ${t.line};
  --accent: ${t.accent};
  --accent-ink: ${t.accentInk};
  --ok: ${t.ok};
  --warn: ${t.warn};
  --danger: ${t.danger};

  --font-display: ${t.fontDisplay};
  --font-body: ${t.fontBody};
  --font-mono: ${t.fontMono};
  --display-weight: ${t.displayWeight};
  --display-tracking: ${t.displayTracking};
  --display-case: ${t.displayCase};

  --radius: ${t.radius};
  --radius-lg: ${t.radiusLg};
  --shadow: ${t.shadow};

  --space: 8px;
  --measure: 68ch;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  letter-spacing: var(--display-tracking);
  text-transform: var(--display-case);
  line-height: 1.15;
  margin: 0 0 calc(var(--space) * 2);
}
h1 { font-size: clamp(2rem, 1.4rem + 2.6vw, 3.25rem); }
h2 { font-size: clamp(1.4rem, 1.1rem + 1.2vw, 2rem); }
h3 { font-size: 1.15rem; }
p  { max-width: var(--measure); }

a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

button, .button {
  font: inherit;
  font-weight: 600;
  padding: calc(var(--space) * 1.25) calc(var(--space) * 2.25);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
}
button:hover, .button:hover { filter: brightness(1.08); }
button[disabled] { opacity: .5; cursor: not-allowed; }

input, select, textarea {
  font: inherit;
  width: 100%;
  padding: calc(var(--space) * 1.25);
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
label { display: block; font-size: .9rem; color: var(--ink-soft); margin-bottom: calc(var(--space) * .5); }

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: calc(var(--space) * 3);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
}
