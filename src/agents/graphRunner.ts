export interface GraphRunContext<S> {
  state: S;
  nodeId: string;
  step: number;
}

export interface GraphNode<S> {
  id: string;
  run(ctx: GraphRunContext<S>): Promise<void>;
}

export type GraphEdge<S> =
  | string
  | undefined
  | ((ctx: GraphRunContext<S>) => string | undefined | Promise<string | undefined>);

export interface GraphDefinition<S> {
  start: string;
  nodes: GraphNode<S>[];
  edges: Record<string, GraphEdge<S>>;
  maxSteps?: number;
}

export async function runGraph<S>(graph: GraphDefinition<S>, state: S): Promise<S> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let nodeId: string | undefined = graph.start;
  let step = 0;
  const maxSteps = graph.maxSteps ?? graph.nodes.length + 5;

  while (nodeId) {
    if (step >= maxSteps) throw new Error(`graph exceeded maxSteps=${maxSteps}`);

    const node = nodes.get(nodeId);
    if (!node) throw new Error(`graph node not found: ${nodeId}`);

    const ctx: GraphRunContext<S> = { state, nodeId, step };
    await node.run(ctx);

    const edge: GraphEdge<S> = graph.edges[nodeId];
    const nextNodeId: string | undefined = typeof edge === "function" ? await edge(ctx) : edge;
    nodeId = nextNodeId;
    step += 1;
  }

  return state;
}
