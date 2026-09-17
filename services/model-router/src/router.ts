export interface ModelDescriptor {
  id: string;
  capabilities: string[];
  maxContext: number;
  supportsTools: boolean;
  local: boolean;
}

export interface RoutingRequest {
  capability: string;
  privacyRequired?: boolean;
  toolRequired?: boolean;
}

export function routeModel(models: ModelDescriptor[], request: RoutingRequest): ModelDescriptor {
  const eligible = models.filter((model) =>
    model.capabilities.includes(request.capability) &&
    (!request.toolRequired || model.supportsTools) &&
    (!request.privacyRequired || model.local)
  );

  const selected = eligible[0];
  if (!selected) throw new Error("No model satisfies the routing requirements");
  return selected;
}
