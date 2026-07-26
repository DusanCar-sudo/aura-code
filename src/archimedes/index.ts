export { ArchimedesModel } from './archimedes-model.js';
export { ArchimedesAlternator } from './alternator.js';
export type { AlternatorOptions, AlternatorRunResult } from './alternator.js';
export {
  assessCompetence,
  updateCompetence,
  getCompetenceReport,
  shouldFineTune,
} from './competence.js';
export {
  saveEpisode,
  loadEpisodes,
  getEpisodeStats,
} from './episode-capture.js';
export type { EpisodeStats } from './episode-capture.js';
export type {
  Episode,
  ArchimedesConfig,
  CompetenceLevel,
  AlternationDecision,
  TrainingExample,
  FineTuneJob,
  TaskCategory,
} from './types.js';
export { DEFAULT_ARCHIMEDES_CONFIG } from './types.js';