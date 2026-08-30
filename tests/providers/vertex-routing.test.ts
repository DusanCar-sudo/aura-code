import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createProvider, apiKeyEnvVarForModel, stripRoutingPrefix,
  vertexBaseUrl, vertexModelId,
} from '../../src/providers/factory.js';

/**
 * Google Vertex AI routing.
 *
 * `vertex` was offered in the model picker as "Gemini via GCP; OAuth2 or ADC"
 * while `case 'vertex'` simply returned the plain `gemini-*` ids — so choosing
 * it used AI Studio, inheriting both its retirements (the whole 2.5 line
 * answers 404 "no longer available to new users" for new keys) and its
 * capacity ("This model is currently experiencing high demand"). Vertex is a
 * separate entitlement and serves those models fine; these tests pin that it
 * now actually goes there.
 */
describe('Vertex AI routing', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VERTEX_PROJECT_ID = 'test-project';
    process.env.GOOGLE_VERTEX_ACCESS_TOKEN = 'ya29.test-token';
    delete process.env.VERTEX_LOCATION;
  });

  afterEach(() => {
    for (const k of ['VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_ACCESS_TOKEN', 'VERTEX_LOCATION']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const endpoint = (p: unknown): string =>
    String((p as { client?: { baseURL?: string } }).client?.baseURL ?? '').replace(/\/+$/, '');

  it('builds the global openapi endpoint under the project', () => {
    expect(vertexBaseUrl('my-proj')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi',
    );
  });

  it('uses the regional host for a non-global location', () => {
    // The global endpoint lives on the bare host; every other location is a
    // subdomain. Getting this backwards is a DNS failure, not a 404.
    expect(vertexBaseUrl('my-proj', 'europe-west4')).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west4/endpoints/openapi',
    );
  });

  it('vendor-qualifies a bare model id, and leaves a qualified one alone', () => {
    expect(vertexModelId('vertex/gemini-3.6-flash')).toBe('google/gemini-3.6-flash');
    expect(vertexModelId('vertex-google/gemini-3.6-flash')).toBe('google/gemini-3.6-flash');
    expect(vertexModelId('google-vertex/gemini-3.6-flash')).toBe('google/gemini-3.6-flash');
    expect(vertexModelId('vertex/meta/llama-4')).toBe('meta/llama-4');
  });

  it('routes vertex/ to Vertex, not to the AI Studio provider', () => {
    const p = createProvider({ model: 'vertex/gemini-3.6-flash' });
    expect(p.name).toBe('Google Vertex AI');
    expect(p.model).toBe('google/gemini-3.6-flash');
    expect(endpoint(p)).toContain('aiplatform.googleapis.com');
  });

  it('still routes a bare gemini- id to AI Studio', () => {
    expect(createProvider({ model: 'gemini-3.6-flash' }).name).toBe('Google');
  });

  it('honours VERTEX_LOCATION', () => {
    process.env.VERTEX_LOCATION = 'us-central1';
    expect(endpoint(createProvider({ model: 'vertex/gemini-3.6-flash' })))
      .toContain('us-central1-aiplatform.googleapis.com');
  });

  it('says what is missing when no project is configured', () => {
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    expect(() => createProvider({ model: 'vertex/gemini-3.6-flash' }))
      .toThrow(/VERTEX_PROJECT_ID/);
  });

  it('strips vertex/ alongside the other routing prefixes', () => {
    expect(stripRoutingPrefix('vertex/gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(stripRoutingPrefix('vertex-google/gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(stripRoutingPrefix('google-vertex/gemini-3.6-flash')).toBe('gemini-3.6-flash');
  });

  it('resolves the token from GOOGLE_VERTEX_ACCESS_TOKEN, not GOOGLE_API_KEY', () => {
    expect(apiKeyEnvVarForModel('vertex/gemini-3.6-flash')).toBe('GOOGLE_VERTEX_ACCESS_TOKEN');
  });

  it('omits the repetition penalties Gemini 3.x rejects', () => {
    // Vertex answers a nonzero frequency_penalty with 400 "Penalty is not
    // enabled for this model". The provider's DeepSeek-tuned 0.3 default must
    // not reach it.
    const p = createProvider({ model: 'vertex/gemini-3.6-flash' }) as unknown as {
      penaltyFields: () => Record<string, number>;
    };
    expect(p.penaltyFields()).toEqual({});
  });

  it('still sends penalties on providers that accept them', () => {
    process.env.DEEPSEEK_API_KEY = 'test';
    const p = createProvider({ model: 'deepseek-v4-flash' }) as unknown as {
      penaltyFields: () => Record<string, number>;
    };
    expect(p.penaltyFields()).toEqual({ frequency_penalty: 0.3, presence_penalty: 0.3 });
  });
});
