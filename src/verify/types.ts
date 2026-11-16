// Aura Code — model-agnostic AI coding agent (Praktess framework).
// Copyright (c) 2026 Dušan Milosavljević <leanproiq@gmail.com>
// SPDX-License-Identifier: MIT
// This file is part of Aura Code, licensed under the MIT License;
// see the LICENSE file at the repository root for the full text.

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: Check[];
  attempts: number;
  suggestion: string;
}

export interface VerificationConfig {
  enabled: boolean;
  maxRetries: number;
  testCommand?: string;
}

export interface ToolCallLogEntry {
  name: string;
  input: Record<string, unknown>;
}
