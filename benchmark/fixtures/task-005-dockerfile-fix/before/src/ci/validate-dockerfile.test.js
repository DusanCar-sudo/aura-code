const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDockerfile } = require('./validate-dockerfile.js');

test('good Dockerfile passes', () => {
  const df = `
    FROM node:18.20.2-alpine
    WORKDIR /app
    COPY package.json ./
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('unpinned base image with :latest is flagged', () => {
  const df = `
    FROM node:latest
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('unpinned base image') || i.includes('latest')));
});

test('unpinned base image with no tag is flagged', () => {
  const df = `
    FROM node
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('unpinned base image') || i.includes('tag')));
});

test('detects COPY of sensitive files', () => {
  const df = `
    FROM node:18.20.2
    COPY .env ./
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('sensitive file') || i.includes('.env')));
});

test('detects ADD of sensitive files', () => {
  const df = `
    FROM node:18.20.2
    ADD id_rsa /root/.ssh/
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('sensitive file') || i.includes('id_rsa')));
});

test('detects missing USER directive', () => {
  const df = `
    FROM node:18.20.2
    COPY . .
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('USER directive') || i.includes('running as root')));
});

test('detects ADD used where COPY suffices', () => {
  const df = `
    FROM node:18.20.2
    ADD package.json ./
    USER node
    CMD ["node", "app.js"]
  `;
  const result = validateDockerfile(df);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('ADD') && i.includes('COPY')));
});
