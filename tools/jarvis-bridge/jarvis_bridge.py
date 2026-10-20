#!/usr/bin/env python3
"""
PANOS-OS Phase 6 — JARVIS Bridge (MARK-LIII)
============================================
Relay script running on the Windows PC alongside JARVIS (Gemini Live).
Forwards spoken utterances to the KHAN OS voice endpoint.

Modes
-----
  CLI:    python jarvis_bridge.py "Hey KHAN, build the dashboard"
  Pipe:   python jarvis_bridge.py --listen          (reads lines from stdin)

Configuration
-------------
  Set env vars (or create a .env file in the same directory):
    KHAN_API_URL  — e.g. http://localhost:3001   (no trailing slash)
    KHAN_API_KEY  — Bearer key from KHAN_API_KEYS

State
-----
  current_task_id is tracked in-process so JARVIS can say
  "approve" / "reject" / "cancel" / "status" without repeating the ID.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ─── .env loader (stdlib only) ────────────────────────────────────────────────────────────────────────────

def _load_dotenv(path: Path) -> None:
    """Load KEY=VALUE pairs from *path* into os.environ (no overwrite)."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
    except FileNotFoundError:
        pass


# Load .env from the same directory as this script
_load_dotenv(Path(__file__).with_name(".env"))

# ─── Config ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

KHAN_API_URL: str = os.environ.get("KHAN_API_URL", "http://localhost:3001").rstrip("/")
KHAN_API_KEY: str | None = os.environ.get("KHAN_API_KEY")

# ─── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

current_task_id: str | None = None

# ─── HTTP helper ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def _post_voice(utterance: str, task_id: str | None = None) -> dict:
    """POST to /v1/voice and return the parsed JSON response."""
    payload: dict = {"utterance": utterance}
    if task_id:
        payload["taskId"] = task_id

    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }
    if KHAN_API_KEY:
        headers["Authorization"] = f"Bearer {KHAN_API_KEY}"

    req = urllib.request.Request(
        f"{KHAN_API_URL}/v1/voice",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            error_body = json.loads(exc.read())
        except Exception:
            error_body = {"detail": str(exc)}
        return {"_http_status": exc.code, **error_body}
    except OSError as exc:
        return {"_error": str(exc)}


# ─── Core relay ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def relay(utterance: str) -> None:
    """
    Send *utterance* to KHAN OS, update local state, and print the result.
    """
    global current_task_id

    utterance = utterance.strip()
    if not utterance:
        return

    # Attach the tracked task ID for context-sensitive intents
    result = _post_voice(utterance, task_id=current_task_id)

    intent = result.get("intent", "unknown")
    message = result.get("message", "")
    returned_task_id = result.get("taskId")

    # Update local task tracking
    if intent == "new_task" and returned_task_id:
        current_task_id = returned_task_id
    elif intent in ("completed", "failed", "cancelled"):
        current_task_id = None

    # Human-readable summary for console / JARVIS TTS
    _status = result.get("_http_status")
    _error = result.get("_error")
    if _error:
        print(f"[BRIDGE ERROR] {_error}", flush=True)
    elif _status and _status >= 400:
        print(f"[KHAN OS {_status}] {result.get('detail', message)}", flush=True)
    else:
        # Print in a format JARVIS (or any caller) can parse:
        # INTENT:<kind> TASK:<id> MSG:<message>
        parts = [f"INTENT:{intent}"]
        if returned_task_id:
            parts.append(f"TASK:{returned_task_id}")
        if message:
            parts.append(f"MSG:{message}")
        print(" ".join(parts), flush=True)


# ─── Entry points ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def _run_listen_mode() -> None:
    """Read utterances from stdin one line at a time (pipe / JARVIS integration)."""
    print("[JARVIS-BRIDGE] Listening on stdin — type utterances and press Enter.",
          flush=True)
    print(f"[JARVIS-BRIDGE] KHAN OS at: {KHAN_API_URL}", flush=True)
    print(f"[JARVIS-BRIDGE] Auth: {'configured' if KHAN_API_KEY else 'anonymous'}",
          flush=True)
    try:
        for line in sys.stdin:
            relay(line)
    except KeyboardInterrupt:
        print("[JARVIS-BRIDGE] Stopped.", flush=True)


def _run_cli_mode(utterance: str) -> None:
    """One-shot CLI: pass utterance as argument, print result, exit."""
    relay(utterance)


def main() -> None:
    args = sys.argv[1:]

    if not args or args == ["--listen"]:
        _run_listen_mode()
        return

    if args[0] == "--listen":
        _run_listen_mode()
        return

    # Everything else: treat as a single utterance (joined with spaces)
    _run_cli_mode(" ".join(args))


if __name__ == "__main__":
    main()
