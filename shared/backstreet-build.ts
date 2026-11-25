/**
 * BackStreet build switches. This POS is a fork of FloCafe; on a computer in the restaurant
 * (hybrid) it must not take updates or register with the original project's services.
 *
 * - upstreamAutoUpdate: the desktop app's updater downloads releases from FreeOpenSourcePOS/FloCafe
 *   (package.json build.publish). Installing one would replace BackStreet's code and could run
 *   database changes BackStreet doesn't have. BackStreet updates come from its own branch.
 * - upstreamCloud: FloAdmin cloud sync (zero-touch registration with the original developer's
 *   servers) and anonymous telemetry. Off: BackStreet data stays with BackStreet.
 */
export const BACKSTREET_BUILD = Object.freeze({
  upstreamAutoUpdate: false,
  upstreamCloud: false,
});
