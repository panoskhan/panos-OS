from dataclasses import asdict
from typing import Dict

from packages.schemas.task import Task, TaskStatus
from services.permissions.permissions import PermissionEngine

class Orchestrator:
    def __init__(self, planner, agents: Dict, permissions: PermissionEngine):
        self.planner = planner
        self.agents = agents
        self.permissions = permissions

    def run(self, goal: str) -> dict:
        task = Task.create(goal)
        task.status = TaskStatus.PLANNING
        plan = self.planner.plan(goal)
        task.steps = plan

        task.status = TaskStatus.EXECUTING
        results = []
        for step in plan:
            agent_name = step["agent"]
            agent = self.agents[agent_name]
            required = step.get("permissions", [])
            if not self.permissions.allowed(required):
                task.status = TaskStatus.WAITING_APPROVAL
                return {"task": asdict(task), "results": results, "approval_required": required}
            results.append(agent.execute(step, task))

        task.status = TaskStatus.VERIFYING
        qa = self.agents["qa"]
        verification = qa.verify(task, results)
        task.status = TaskStatus.COMPLETED if verification["passed"] else TaskStatus.FAILED
        return {"task": asdict(task), "results": results, "verification": verification}
