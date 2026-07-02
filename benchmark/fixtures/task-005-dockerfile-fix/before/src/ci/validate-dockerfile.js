/**
 * Validates a Dockerfile string for common best-practice violations.
 * @param {string} content — raw Dockerfile text
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validateDockerfile(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const issues = [];

  // BUG 1: Checks FROM exists but NOT for :latest or missing tag
  const fromLine = lines.find(l => l.startsWith('FROM '));
  if (!fromLine) {
    issues.push('Missing FROM instruction');
  }

  // BUG 2: Never checks COPY/ADD for sensitive files (.env, secrets, id_rsa)

  // BUG 3: Never checks for USER directive (runs as root by default)

  // Only checks: no CMD or ENTRYPOINT
  const hasCmd = lines.some(l => l.startsWith('CMD ') || l.startsWith('ENTRYPOINT '));
  if (!hasCmd) {
    issues.push('Missing CMD or ENTRYPOINT');
  }

  return { valid: issues.length === 0, issues };
}

module.exports = { validateDockerfile };
