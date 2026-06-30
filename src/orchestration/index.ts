export { routeTask } from './router.js';
export { createPlan } from './orchestrator.js';
export { executePlan, synthesise } from './executor.js';
export { runSpecialist, runResearcher, runReviewer, runCoder } from './specialists.js';
import { planStore } from './plan-store.js';
import type { ExecutionPlan, OrchestrationMemory } from './types.js';
export const savePlan   = (plan: ExecutionPlan)                                      => planStore.save(plan);
export const loadPlan   = (id: string)                                               => planStore.load(id);
export const listPlans  = ()                                                          => planStore.list();
export const deletePlan = (id: string)                                               => planStore.delete(id);
export const saveMemory = (projectRoot: string, entry: OrchestrationMemory)          => planStore.saveMemory(projectRoot, entry);
export const getMemory  = (projectRoot: string, key: string)                         => planStore.getMemory(projectRoot, key);
export const listMemory = (projectRoot: string)                                      => planStore.listMemory(projectRoot);
export type {
  ExecutionPlan,
  PlanStep,
  OrchestrationMemory,
  RouterDecision,
} from './types.js';
export type { OrchestratorOptions } from './orchestrator.js';
export type { ExecutorOptions } from './executor.js';
export type { SpecialistOptions, SpecialistResult } from './specialists.js';
export type {
  RubyFramework,
  RubyTestFramework,
  RubyProjectContext,
  RubyDiamondSurface,
  RubyDiamondEnvelope,
} from './ruby-types.js';
export { detectRubyProject } from './ruby-detect.js';
export type {
  SpecialistRole,
  CompetenceDomain,
  CompetenceScore,
  ProjectCompetence,
  StepOutcome,
} from './competence.js';
export {
  PRIMARY_DOMAIN,
  defaultCompetenceMatrix,
  recommendSpecialist,
  applyOutcome,
  competenceStore,
} from './competence.js';
