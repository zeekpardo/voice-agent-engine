/**
 * Canonical id-safe slug used by the gateway (root) to turn free-text names
 * (flow node exit names, scenario names, …) into `[a-z0-9_]` tool-id fragments:
 * lowercase, non-alphanumeric runs collapsed to a single underscore, leading/
 * trailing underscores trimmed.
 *
 * worker/src/main.ts intentionally keeps its own copy of this function (see the
 * comment there): `lk agent deploy` builds the worker's Docker image from the
 * worker/ directory alone, so this workspace package isn't available in that
 * build context. Keep that copy in sync with this file by hand if it changes.
 */
export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}
