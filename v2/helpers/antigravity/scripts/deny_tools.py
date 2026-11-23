"""Task-local PreToolUse handler: every path returns the documented hard deny."""
import json
from pathlib import Path
import re
import sys


def main():
    name = "UNKNOWN"
    try:
        data = json.loads(sys.stdin.read(1024 * 1024))
        candidate = data.get("toolCall", {}).get("name", "UNKNOWN")
        if isinstance(candidate, str) and re.fullmatch(r"[a-zA-Z0-9_.:/-]{1,128}", candidate):
            name = candidate
    except (ValueError, AttributeError, TypeError, OSError):
        pass
    # Never retain args, private file paths, prompt material, or tool output.
    try:
        with Path(sys.argv[1]).open("a", encoding="utf-8") as audit:
            audit.write(json.dumps({"tool_name": name, "decision": "deny"}) + "\n")
    finally:
        print(json.dumps({"decision": "deny", "reason": "Codex selected-context helper permits text responses only."}), flush=True)


if __name__ == "__main__":
    main()
