import type { PlanStep } from "./index";

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePlan(plan: PlanStep[]): PlanValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const task of plan) {
    if (ids.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    } else {
      ids.add(task.id);
    }
  }

  for (const task of plan) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        errors.push(`Task ${task.id} cannot depend on itself`);
      } else if (!ids.has(dependency)) {
        errors.push(`Task ${task.id} depends on missing task: ${dependency}`);
      }
    }
  }

  const dependencies = new Map(plan.map((task) => [task.id, task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleKeys = new Set<string>();

  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(" -> ");
      const key = [...new Set(path.slice(cycleStart))].sort().join("|");
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        errors.push(`Dependency cycle detected: ${cycle}`);
      }
      return;
    }

    if (visited.has(id) || !dependencies.has(id)) return;

    visiting.add(id);
    const nextPath = [...path, id];
    for (const dependency of dependencies.get(id) ?? []) {
      visit(dependency, nextPath);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of plan) {
    visit(task.id, []);
  }

  return { valid: errors.length === 0, errors };
}
