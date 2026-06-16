# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅ Yes    |
| 0.2.x   | ❌ No     |
| 0.1.x   | ❌ No     |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **leanproiq@gmail.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Assessment**: within 1 week
- **Fix release**: depends on severity (critical = days, low = next minor release)

## Scope

Aura Code runs locally and sends prompts to LLM APIs. Key security considerations:

- **Shell execution**: Aura can run arbitrary shell commands. The permission system (`normal`, `read-only`, `auto`) controls this.
- **API keys**: Stored as environment variables, never logged or transmitted anywhere except the configured LLM provider.
- **File access**: Aura reads and writes files in the working directory. The safety system restricts access outside the project root.

## Responsible Disclosure

We appreciate responsible disclosure. If you report a valid vulnerability, we will credit you in the release notes (unless you prefer to remain anonymous).
