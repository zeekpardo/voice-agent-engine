#!/usr/bin/env bash
# PostToolUse (Edit|Write) hook: when an edited file is one half of a
# hand-synced worker pair, remind to check its counterpart. The worker can't
# import workspace packages (lk agent deploy builds worker/ standalone), so
# these copies are kept in sync BY HAND. Advisory only — always exits 0.
#
# Reads the PostToolUse JSON on stdin (tool_input.file_path). Also honors the
# CLAUDE_FILE_PATHS env var if present (space/newline-separated).
set -euo pipefail

input="$(cat 2>/dev/null || true)"

# Collect candidate paths: the stdin file_path plus any CLAUDE_FILE_PATHS.
paths=""
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  paths="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
fi
if [ -z "$paths" ] && [ -n "$input" ]; then
  # Fallback without jq: crude extraction of the first file_path value.
  paths="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
if [ -n "${CLAUDE_FILE_PATHS:-}" ]; then
  paths="$paths
${CLAUDE_FILE_PATHS}"
fi

[ -z "${paths//[[:space:]]/}" ] && exit 0

# Emit the counterpart reminder for a given matched path.
remind() {
  printf '\n\033[1;33m⚠  HAND-SYNCED FILE EDITED\033[0m — %s\n' "$1" >&2
  printf '   %s\n' "$2" >&2
  printf '   The worker builds standalone (lk agent deploy), so these copies do NOT auto-share.\n' >&2
  printf '   Re-sync by hand, then run the sync-checker agent / sync-worker-copies skill.\n\n' >&2
}

hit=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  case "$p" in
    */packages/shared/src/hmac.ts|packages/shared/src/hmac.ts)
      remind "$p" "Counterpart: worker/src/tools.ts  (sign() must match signPayload)"; hit=1 ;;
    */worker/src/tools.ts|worker/src/tools.ts)
      remind "$p" "Counterpart: packages/shared/src/hmac.ts  (sign() must match signPayload)"; hit=1 ;;
    */packages/shared/src/slugify.ts|packages/shared/src/slugify.ts)
      remind "$p" "Counterpart: worker/src/flow/agent-builder.ts  (sanitize() must match slugify)"; hit=1 ;;
    */worker/src/flow/agent-builder.ts|worker/src/flow/agent-builder.ts)
      remind "$p" "Counterpart: packages/shared/src/slugify.ts  (sanitize() must match slugify)"; hit=1 ;;
    */src/lib/agent-config.ts|src/lib/agent-config.ts)
      remind "$p" "Counterpart: worker/src/gateway.ts  (AgentConfig/FlowNode TS interfaces must mirror the Zod schema)"; hit=1 ;;
    */worker/src/gateway.ts|worker/src/gateway.ts)
      remind "$p" "Counterpart: src/lib/agent-config.ts  (AgentConfig/FlowNode Zod schema this interface mirrors)"; hit=1 ;;
  esac
done <<EOF
$paths
EOF

# Surface a durable note to the model too (only when we matched something).
if [ "$hit" -eq 1 ] && command -v jq >/dev/null 2>&1; then
  jq -n '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"A hand-synced worker/shared pair was just edited. The worker builds standalone and does NOT share workspace code, so update the counterpart file by hand and run the sync-checker agent. See CLAUDE.md \"hand-synced files\"."}}'
fi

exit 0
