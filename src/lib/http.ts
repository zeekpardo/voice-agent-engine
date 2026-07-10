import type { Context } from "hono";
import type { ZodIssue, ZodType, ZodTypeDef } from "zod";
import { badRequest } from "./errors.js";

/**
 * Validate `raw` against `schema`, throwing the same bad-request AppError
 * every route used to hand-roll on failure. `message` formats the error from
 * the first zod issue (schema-level failures) or `undefined` (the value
 * itself wasn't even parseable, e.g. non-JSON body).
 *
 * Output/Input are separate type params (rather than a single `ZodType<T>`)
 * so schemas with `.default(...)` fields — where the parsed output differs
 * from the raw input — still infer their real output type.
 */
export function parseOrThrow<Output, Input>(
	schema: ZodType<Output, ZodTypeDef, Input>,
	raw: unknown,
	message: (issue: ZodIssue | undefined) => string,
): Output {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw badRequest(message(parsed.error.issues[0]));
	return parsed.data;
}

/** Same as {@link parseOrThrow}, but reads + JSON-parses the request body first. */
export async function parseBody<Output, Input>(
	c: Context,
	schema: ZodType<Output, ZodTypeDef, Input>,
	message: (issue: ZodIssue | undefined) => string,
): Promise<Output> {
	return parseOrThrow(schema, await c.req.json().catch(() => null), message);
}
