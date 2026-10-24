// The web UI is static, except for index.html: upstream (ui/serve.go) replaces the
// first "%CONFIG%" in it with a JSON object the UI reads as window.config.

import type { GotifyConfig } from './config.ts';
import { goJSON } from './http.ts';

/** The JSON for window.config (upstream's uiConfig struct, with Go's json.Marshal escaping). */
export function uiConfigJson(config: GotifyConfig): string {
  return goJSON({
    register: config.registration,
    version: config.version,
    localAuth: config.localAuthEnabled,
    oidc: false,
    oidcIdpName: config.oidcIdpName,
    oidcAutoRedirect: false,
  });
}

/** strings.Replace(content, "%CONFIG%", configJson, 1). A function replacer keeps "$" in the JSON literal. */
export function renderIndex(html: string, configJson: string): string {
  return html.replace('%CONFIG%', () => configJson);
}
