// ─────────────────────────────────────────────────────────────────────────────
// FTP Upload — upload a local file to an FTP server
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDefinition } from '../providers/types.js';
import { execSync } from 'child_process';
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

export function ftpUpload(input: FtpUploadInput): string {
  const port = input.port ?? 21;
  const localFile = input.localFile;

  if (!fs.existsSync(localFile)) {
    return `Error: Local file not found: ${localFile}`;
  }

  // Build curl FTP upload command
  // --ftp-create-dirs creates remote directories if they don't exist
  const curlCmd = [
    'curl',
    '--ftp-create-dirs',
    '-T', JSON.stringify(localFile),
    `ftp://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${input.host}:${port}${input.remoteDir}`,
  ].join(' ');

  try {
    execSync(curlCmd, { stdio: 'inherit' });
    return `✓ Uploaded ${localFile} to ftp://${input.host}:${port}${input.remoteDir}`;
  } catch (err) {
    return `✗ FTP upload failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
