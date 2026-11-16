// Aura Code — model-agnostic AI coding agent (Praktess framework).
// Copyright (c) 2026 Dušan Milosavljević <leanproiq@gmail.com>
// SPDX-License-Identifier: MIT
// This file is part of Aura Code, licensed under the MIT License;
// see the LICENSE file at the repository root for the full text.

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