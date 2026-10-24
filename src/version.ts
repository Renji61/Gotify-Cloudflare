// Version information reported by GET /version, /gotifyinfo and the UI config.
// Upstream fills these in at build time; here they are fixed to the ported release.
export const VERSION_INFO = {
  version: '3.1.1',
  // Commit and date of the upstream tag v3.1.1 that this port follows.
  commit: 'e6361caa512547052b1013dbf4544e6d7ff32604',
  buildDate: '2026-09-12T17:22:24Z',
};

export type VersionInfo = typeof VERSION_INFO;
