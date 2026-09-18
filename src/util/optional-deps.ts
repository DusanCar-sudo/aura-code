/**
 * Optional dependencies: installed by default, but an install may skip them
 * (`npm i --omit=optional`, a platform without a prebuilt binary). The code
 * that needs one loads it here, so a missing module becomes a sentence the
 * user can act on instead of a module-resolution stack trace.
 */

export class MissingOptionalDependency extends Error {
  constructor(readonly pkg: string, what: string) {
    super(`${what} needs the optional package ${pkg}, which is not installed. `
      + `Reinstall with optional dependencies: npm i -g aura-code --include=optional`);
    this.name = 'MissingOptionalDependency';
  }
}

function isMissing(e: unknown, pkg: string): boolean {
  const err = e as { code?: string; message?: string };
  return (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND')
    && String(err.message ?? '').includes(pkg);
}

/** puppeteer-core: the browser tool, design renders, video renders. */
export async function loadPuppeteer(what = 'This feature'): Promise<typeof import('puppeteer-core')> {
  try {
    return await import('puppeteer-core');
  } catch (e) {
    if (isMissing(e, 'puppeteer-core')) throw new MissingOptionalDependency('puppeteer-core', what);
    throw e;
  }
}
