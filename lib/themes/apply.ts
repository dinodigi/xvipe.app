/**
 * lib/themes/apply.ts — put a theme on an app.
 *
 * Writing a theme is a single file write plus a metadata note. No model call,
 * no rebuild, no agent turn — which is why the studio can offer instant theme
 * switching and why the agent must style against token names rather than raw
 * colour values.
 */
import { updateApp, wsWrite } from "@/lib/apps/store";
import { DEFAULT_THEME_ID, getTheme, renderThemeCss, THEME_FILE } from "@/lib/themes";

export interface AppliedTheme {
  themeId: string;
  file: string;
  bytes: number;
}

export function applyTheme(slug: string, themeId: string): AppliedTheme {
  const theme = getTheme(themeId);
  if (!theme) throw new Error(`Unknown theme: ${themeId}`);
  const file = wsWrite(slug, THEME_FILE, renderThemeCss(theme));
  updateApp(slug, { themeId: theme.id });
  return { themeId: theme.id, file: file.path, bytes: file.bytes };
}

/** Give a brand-new app a theme so it is never unstyled on its first render. */
export const applyDefaultTheme = (slug: string): AppliedTheme => applyTheme(slug, DEFAULT_THEME_ID);
