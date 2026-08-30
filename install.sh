#!/usr/bin/env bash
# smartbill-mcp — one-command installer for Claude (Desktop/Code) and Codex.
# Usage: ./install.sh            (or)   curl -fsSL <raw-url>/install.sh | bash
# Installs: (1) the remote MCP server, (2) the accounting-invoicing skill.

set -euo pipefail

MCP_URL="https://smartbill-mcp.ethan1709.workers.dev/mcp"
SKILL_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes/skills/accounting/invoicing"
CLAUDERC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json"
CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"

echo "== smartbill-mcp installer =="
echo "MCP endpoint: $MCP_URL"

# ---- 1. Claude Desktop / Claude Code ----
if command -v claude >/dev/null 2>&1; then
  echo "== Claude detected — registering MCP server =="
  claude mcp add smartbill-mcp -- npx -y mcp-remote "$MCP_URL" || echo "  (claude mcp add failed — add manually: see README)"
else
  echo "== Claude not on PATH — patching $CLAUDERC if present =="
  if [ -f "$CLAUDERC" ]; then
    python3 - "$CLAUDERC" "$MCP_URL" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
try:
    with open(path) as f: cfg = json.load(f)
except Exception:
    cfg = {}
servers = cfg.setdefault("mcpServers", {})
servers["smartbill-mcp"] = {"command": "npx", "args": ["-y", "mcp-remote", url]}
with open(path, "w") as f: json.dump(cfg, f, indent=2)
print("  patched", path)
PY
  else
    echo "  (no Claude config found — install Claude or add manually)"
  fi
fi

# ---- 2. Codex ----
if command -v codex >/dev/null 2>&1; then
  echo "== Codex detected — registering MCP server =="
  mkdir -p "$(dirname "$CODEX_CFG")"
  if [ -f "$CODEX_CFG" ]; then
    python3 - "$CODEX_CFG" "$MCP_URL" <<'PY'
import sys
path, url = sys.argv[1], sys.argv[2]
text = open(path).read()
block = f'\n[mcp_servers.smartbill-mcp]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "{url}"]\n'
if "smartbill-mcp" not in text:
    open(path, "a").write(block)
    print("  appended to", path)
else:
    print("  already present in", path)
PY
  else
    printf '\n[mcp_servers.smartbill-mcp]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "%s"]\n' "$MCP_URL" > "$CODEX_CFG"
    echo "  created $CODEX_CFG"
  fi
else
  echo "== Codex not on PATH — skipping (add manually: see README) =="
fi

# ---- 3. Hermes skill ----
if [ -d "$HOME/.hermes/skills" ]; then
  echo "== Installing accounting-invoicing skill to Hermes =="
  mkdir -p "$HOME/.hermes/skills/accounting"
  cp -R "$SKILL_SRC" "$HOME/.hermes/skills/accounting/invoicing"
  echo "  installed → $HOME/.hermes/skills/accounting/invoicing"
fi

echo ""
echo "== Done. Next steps =="
echo "1. Restart your AI tool."
echo "2. First use: a GitHub sign-in opens in the browser → Authorize."
echo "3. Then: register your SmartBill account (email + API token + CIF from cloud.smartbill.ro → Contul meu → Integrări)."
echo "4. Chat: 'create invoice for Acme 500 RON'."
