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
