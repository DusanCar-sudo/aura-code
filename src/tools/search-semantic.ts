// Aura Code — model-agnostic AI coding agent (Praktess framework).
// Copyright (c) 2026 Dušan Milosavljević <leanproiq@gmail.com>
// SPDX-License-Identifier: MIT
// This file is part of Aura Code, licensed under the MIT License;
// see the LICENSE file at the repository root for the full text.

import { extractSemanticContext } from '../perception/semantic-search.js';
import { resolveInRoot, PathJailError } from '../safety/path-jail.js';

export interface SearchSemanticInput {
  path: string;
  query?: string;
}

export function searchSemantic(input: SearchSemanticInput, cwd: string): string {
  let filePath: string;
  try {
    filePath = resolveInRoot(cwd, input.path);
  } catch (e) {
    if (e instanceof PathJailError) return `Error: ${e.message}`;
    throw e;
  }

  return extractSemanticContext(filePath, input.query);
}
