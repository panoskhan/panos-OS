"""Minimal runnable KHAN OS vertical slice API.

Run:
    python -m apps.api.khan_api
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path

from services.orchestrator.orchestrator import Orchestrator
from agents.planner.planner import PlannerAgent
from agents.coding.coding import CodingAgent
from agents.qa.qa import QAAgent
from services.permissions.permissions import PermissionEngine

ROOT = Path(__file__).resolve().parents[2]

orchestrator = Orchestrator(
    planner=PlannerAgent(),
    agents={"coding": CodingAgent(), "qa": QAAgent()},
    permissions=PermissionEngine(),
)

class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "service": "khan-os"})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/tasks":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
            goal = str(data.get("goal", "")).strip()
            if not goal:
                self._json(400, {"error": "goal_required"})
                return
            result = orchestrator.run(goal)
            self._json(200, result)
        except Exception as exc:
            self._json(500, {"error": "execution_failed", "detail": str(exc)})

if __name__ == "__main__":
    print("KHAN OS API listening on http://127.0.0.1:8000")
    HTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
