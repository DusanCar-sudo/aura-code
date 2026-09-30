// ─────────────────────────────────────────────────────────────────────────────
// FTP Upload — upload a local file to an FTP server
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDefinition } from '../providers/types.js';
import { run } from '../util/exec.js';
import * as fs from 'fs';

export interface FtpUploadInput {
  host: string;
  port?: number;
  username: string;
  password: string;
  remoteDir: string;
  localFile: string;
}

export const FTP_UPLOAD_DEFINITION: ToolDefinition = {
  name: 'ftp_upload',
  description:
    'Upload a local file to an FTP server. Uses curl under the hood. ' +
    'Provide host, username, password, remote directory, and local file path.',
  parameters: {
    type: 'object',
    properties: {
      host:      { type: 'string', description: 'FTP server hostname' },
      port:      { type: 'number', description: 'FTP server port (default: 21)' },
      username:  { type: 'string', description: 'FTP username' },
      password:  { type: 'string', description: 'FTP password' },
      remoteDir: { type: 'string', description: 'Remote directory path (e.g. /htdocs/)' },
      localFile: { type: 'string', description: 'Local file path to upload' },
    },
    required: ['host', 'username', 'password', 'remoteDir', 'localFile'],
  },
};

/** curl config-file string: backslash and double quote escaped. */
function curlQuote(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function ftpUpload(input: FtpUploadInput): string {
  const port = input.port ?? 21;
  const localFile = input.localFile;

  if (!fs.existsSync(localFile)) {
    return `Error: Local file not found: ${localFile}`;
  }
  // Everything that lands in the URL is checked, so a value can't smuggle in
  // another host, a query or a second URL.
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(input.host) && !/^\[[0-9A-Fa-f:.]+\]$/.test(input.host)) {
    return `Error: invalid FTP host: ${input.host}`;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `Error: invalid FTP port: ${input.port}`;
  }
  if (!/^\/[^\s?#@\\]*$/.test(input.remoteDir)) {
    return `Error: remoteDir must be an absolute path without spaces, ?, #, @ or backslashes: ${input.remoteDir}`;
  }
  if (/[\r\n]/.test(input.username + input.password)) {
    return 'Error: username and password cannot contain line breaks';
  }

  const url = `ftp://${input.host}:${port}${input.remoteDir}`;
  // Credentials go to curl on stdin as a config line (-K -): never in argv,
  // where every user on the machine can read them in `ps`, and never in a URL.
  const r = run('curl', ['--silent', '--show-error', '--ftp-create-dirs', '-K', '-', '-T', localFile, url], {
    input: `user = ${curlQuote(`${input.username}:${input.password}`)}\n`,
    timeoutMs: 10 * 60_000,
  });
  if (r.error) return `✗ FTP upload failed: ${r.error.message}`;
  if (r.status !== 0) return `✗ FTP upload failed (curl exit ${r.status}): ${r.stderr.trim()}`;
  return `✓ Uploaded ${localFile} to ${url}`;
}
