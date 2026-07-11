/**
 * Per-group usage attribution: `group_ref` is an OPAQUE tenant tag the consuming
 * SaaS gives meaning to. The engine stays CRM-neutral and never interprets it.
 *
 * Resolution rule shared by the outbound + web-session birth paths: prefer an
 * explicit top-level `group_ref`, otherwise fall back to `metadata.source_id`
 * (which the SaaS already sends today) so existing callers stay attributed
 * without any change on their side.
 */
export function resolveGroupRef(
	explicit: string | undefined,
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	if (explicit) return explicit;
	const fromMeta = metadata?.source_id;
	return typeof fromMeta === "string" && fromMeta.length > 0 ? fromMeta : undefined;
}
