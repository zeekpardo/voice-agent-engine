// ============================================================================
// DO NOT EDIT — GENERATED FILE.
//
// Vendored verbatim from packages/shared/src/slugify.ts by `pnpm sync:worker`.
// The worker builds standalone (`lk agent deploy` uses worker/ as the entire
// Docker build context), so it can't import @voice-engine/shared. Edit the
// canonical file in packages/shared/src/ and re-run `pnpm sync:worker`.
// CI runs `pnpm sync:worker --check` to fail on drift.
// ============================================================================

/**
 * Canonical id-safe slug used by the gateway (root) to turn free-text names
 * (flow node exit names, scenario names, …) into `[a-z0-9_]` tool-id fragments:
 * lowercase, non-alphanumeric runs collapsed to a single underscore, leading/
 * trailing underscores trimmed.
 *
 * The worker cannot import this workspace package (`lk agent deploy` builds the
 * worker's Docker image from the worker/ directory alone). Instead this file is
 * VENDORED into worker/src/vendor/slugify.ts by `pnpm sync:worker`; the worker
 * imports the vendored copy. This file stays canonical — edit here, then run
 * `pnpm sync:worker` (CI runs `pnpm sync:worker --check` to catch drift).
 */
export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}
