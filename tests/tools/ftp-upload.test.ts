import { describe, it, expect, vi } from 'vitest';
import { FTP_UPLOAD_DEFINITION, ftpUpload } from '../../src/tools/ftp-upload.js';

describe('ftp_upload tool', () => {
  it('exposes a tool definition with required fields', () => {
    expect(FTP_UPLOAD_DEFINITION.name).toBe('ftp_upload');
    expect(FTP_UPLOAD_DEFINITION.parameters.required).toEqual(
      expect.arrayContaining(['host', 'username', 'password', 'remoteDir', 'localFile']),
    );
  });

  it('returns an error when the local file does not exist', async () => {
    const result = await ftpUpload({
      host: 'example.com',
      username: 'user',
      password: 'pass',
      remoteDir: '/htdocs/',
      localFile: '/tmp/does-not-exist-ftp-test.txt',
    });
    expect(result).toContain('Error: Local file not found');
  });
});
