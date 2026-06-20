/**
 * Xiaomi MiMo has two auth products:
 * - Pay-as-you-go: sk-… keys → https://api.xiaomimimo.com/v1
 * - Token Plan: tp-… keys → https://token-plan-{region}.xiaomimimo.com/v1
 *
 * Token Plan does not accept legacy chat ids like mimo-v2-flash (400 Not supported model).
 */

export type XiaomiKeyKind = 'token-plan' | 'paygo' | 'unknown';

export function xiaomiKeyKind(apiKey?: string): XiaomiKeyKind {
  const k = apiKey?.trim() ?? '';
  if (k.startsWith('tp-')) return 'token-plan';
  if (k.startsWith('sk-')) return 'paygo';
  return 'unknown';
}

export function defaultXiaomiBaseUrl(apiKey?: string, region: 'sgp' | 'cn' | 'ams' = 'sgp'): string {
  const kind = xiaomiKeyKind(apiKey);
  if (kind === 'paygo') return 'https://api.xiaomimimo.com/v1';
  if (kind === 'token-plan') {
    return `https://token-plan-${region}.xiaomimimo.com/v1`;
  }
  return 'https://token-plan-sgp.xiaomimimo.com/v1';
}

/** Models that work on Token Plan (tp- keys). */
export const XIAOMI_TOKEN_PLAN_MODELS = ['mimo-v2.5-pro', 'mimo-v2.5'] as const;

/** Extra models for pay-as-you-go (sk- keys). */
export const XIAOMI_PAYGO_EXTRA_MODELS = ['mimo-v2-flash', 'mimo-v2-pro', 'mimo-v1'] as const;

export function isTokenPlanBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes('token-plan');
}

/**
 * Adjust model + base URL for the key type. Returns a message when auto-correcting.
 */
export function normalizeXiaomiWizardConfig(
  model: string,
  apiKey: string | undefined,
  baseUrl: string,
): { model: string; baseUrl: string; note?: string } {
  const kind = xiaomiKeyKind(apiKey);
  let outModel = model;
  let outBase = baseUrl.trim() || defaultXiaomiBaseUrl(apiKey);
  let note: string | undefined;

  if (kind === 'token-plan' || isTokenPlanBaseUrl(outBase)) {
    if (!outBase.includes('token-plan')) {
      outBase = defaultXiaomiBaseUrl(apiKey);
      note = 'Token Plan key detected — using Token Plan base URL.';
    }
    if (!XIAOMI_TOKEN_PLAN_MODELS.includes(outModel as typeof XIAOMI_TOKEN_PLAN_MODELS[number])) {
      const replacement = outModel.includes('pro') ? 'mimo-v2.5-pro' : 'mimo-v2.5';
      note = (note ? note + ' ' : '') +
        `Token Plan does not support "${model}" — using ${replacement} instead.`;
      outModel = replacement;
    }
  } else if (kind === 'paygo') {
    if (outBase.includes('token-plan')) {
      outBase = defaultXiaomiBaseUrl(apiKey);
      note = 'Pay-as-you-go key (sk-) — using api.xiaomimimo.com.';
    }
  }

  return { model: outModel, baseUrl: outBase, note };
}