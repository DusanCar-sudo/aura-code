export { extractPerception } from './extractor.js';
export { savePerception, loadPerception, isStale, clearPerception } from './graph-store.js';
export { getDependencies, getImpact, getConstraints, getRiskAreas, getTrajectory, findRelated } from './queries.js';
export type { ProjectPerception, ArchitectureNode, ArchitectureEdge, PerceptionQuery, PerceptionQueryResult } from './types.js';
