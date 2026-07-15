import * as fs from 'fs';
import * as path from 'path';

export interface SemanticSearchResult {
  filePath: string;
  outline: string[];
  snippets: string[];
}

export function extractSemanticContext(filePath: string, query?: string): string {
  if (!fs.existsSync(filePath)) {
    return `Error: File not found - ${filePath}`;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  const ext = path.extname(filePath);
  const outline: string[] = [];
  const snippets: string[] = [];
  
  // Basic regexes for TS/JS/Python
  const classRegex = /^(?:export\s+)?(?:default\s+)?class\s+(\w+)/;
  const funcRegex = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const methodRegex = /^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/;
  const pyClassRegex = /^class\s+(\w+)/;
  const pyDefRegex = /^\s*def\s+(\w+)/;

  let currentContext = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Build outline
    if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      if (classRegex.test(trimmed)) outline.push(`${i + 1}: ${trimmed}`);
      else if (funcRegex.test(trimmed)) outline.push(`${i + 1}: ${trimmed}`);
      else if (line.startsWith(' ') && methodRegex.test(trimmed) && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while')) {
         outline.push(`${i + 1}:   ${trimmed.split('{')[0]}`);
      }
    } else if (ext === '.py') {
      if (pyClassRegex.test(trimmed) || pyDefRegex.test(trimmed)) {
        outline.push(`${i + 1}: ${line}`);
      }
    }

    // Extract snippet if query is provided
    if (query && line.toLowerCase().includes(query.toLowerCase())) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length - 1, i + 5);
      const snippet = lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
      snippets.push(`--- Match around line ${i + 1} ---\n${snippet}`);
      i = end; // Skip to avoid overlap
    }
  }

  let result = `File: ${filePath}\n`;
  result += `Total Lines: ${lines.length}\n\n`;
  
  if (outline.length > 0) {
    result += `=== File Outline ===\n${outline.join('\n')}\n\n`;
  } else {
    result += `=== File Outline ===\n(No classes or functions detected)\n\n`;
  }

  if (query) {
    if (snippets.length > 0) {
      result += `=== Search Matches for "${query}" ===\n`;
      result += snippets.slice(0, 5).join('\n\n');
      if (snippets.length > 5) {
        result += `\n\n... and ${snippets.length - 5} more matches truncated.`;
      }
    } else {
      result += `=== Search Matches ===\nNo semantic matches found for "${query}".\n`;
    }
  }

  return result;
}
