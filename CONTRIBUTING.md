# Contributing to Aura Code

Thanks for your interest in contributing! Aura Code is built by humans and AI agents working together.

## Getting Started

```bash
git clone https://github.com/milodule3-debug/aura-code.git
cd aura-code
npm install
npm run build
npm test
```

## Development Workflow

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feature/your-feature`
3. **Make changes** — keep commits focused and atomic
4. **Run tests**: `npm test` (must pass, zero failures)
5. **Build**: `npm run build` (must be clean, no type errors)
6. **Submit a Pull Request** with a clear description

## Code Standards

- **TypeScript strict mode** — no `any` types without justification
- **Tests required** — new features need tests, bug fixes need regression tests
- **Match existing style** — indentation, naming conventions, comment style
- **No unnecessary dependencies** — prefer built-in Node.js APIs

## Project Structure

```
src/
├── agent/          # Core agent loop
├── architect/      # High-level design mode
├── cli/            # CLI entry point and argument parsing
├── config/         # Configuration management
├── harness/        # Self-improvement loop
├── orchestration/  # Multi-agent orchestration
├── providers/      # LLM provider integrations (Claude, GPT, Gemini, MiMo, Ollama)
├── safety/         # Permission system and guardrails
├── tools/          # Tool implementations (read, edit, shell, etc.)
├── util/           # Shared utilities
├── verify/         # Post-task verification
└── workflows/      # Workflow definitions
tests/              # Mirrors src/ structure
```

## Running Specific Tests

```bash
npx vitest run tests/tools.test.ts           # Single file
npx vitest run --reporter verbose            # Detailed output
npm run test:coverage                         # With coverage report
```

## Reporting Issues

- Use [GitHub Issues](https://github.com/milodule3-debug/aura-code/issues)
- Include: Aura version (`aura --version`), Node.js version, OS, steps to reproduce
- For security issues, email leanproiq@gmail.com directly

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
