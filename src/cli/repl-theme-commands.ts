/**
 * `:theme` — the TUI's palette switcher.
 *
 * The themes are Aura adOS's own: the flat seven-token `key=value` files the
 * OS ships and wears (see theme.ts). This command lists what is installed,
 * wears one, and can follow the OS.
 *
 *   :theme              list the installed themes
 *   :theme <name>       wear <name>, remembered in ~/.aura/theme
 *   :theme sync         wear whatever adOS is wearing
 *   :theme reset        back to the default
 */

import chalk from 'chalk';
import { CHROME, FAINT, TEXT, TEXT_DIM } from './diamond.js';
import {
  adOSThemeId, allThemes, auraThemeFile, currentTheme, DEFAULT_THEME_ID,
  saveThemeChoice, setTheme, type Theme, type ThemeToken,
} from './theme.js';
import { emit } from '../commands/surface.js';
import type { ReplCommandResult } from './repl-session-commands.js';

const USAGE = [
  '  :theme              list the installed themes',
  '  :theme <name>       wear a theme (remembered in ~/.aura/theme)',
  '  :theme sync         follow the theme adOS is wearing',
  '  :theme reset        back to the default',
].join('\n');

const tilde = (p: string): string => p.replace(process.env.HOME ?? '\0', '~');

/** A strip of the theme's own colours, painted with the theme's own hues. */
function swatch(theme: Theme): string {
  const slots: ThemeToken[] = ['chrome', 'accent2', 'ok', 'warn', 'err', 'info', 'fg', 'dim'];
  return slots.map(s => chalk.bgHex(theme.tokens[s])(' ')).join('') + ' ';
}

function themeLine(theme: Theme, active: boolean): string {
  const marker = active ? CHROME('●') : FAINT('○');
  const name = active ? TEXT(theme.name) : TEXT_DIM(theme.name);
  const id = FAINT(theme.id.padEnd(14));
  const from = theme.source === 'built-in' ? 'built-in' : tilde(theme.source);
  return `  ${marker} ${id}${swatch(theme)}${name}  ${FAINT(from)}`;
}

/** Switch, remember the choice, and say so. False when the id is unknown. */
function wear(id: string): boolean {
  const next = setTheme(id);
  if (!next) return false;
  saveThemeChoice(next.id);
  emit('\n  ' + CHROME('● ') + TEXT(next.name) + swatch(next) + TEXT_DIM(`  ${next.id}`) + FAINT(' — saved') + '\n');
  return true;
}

function listThemes(): void {
  const active = currentTheme().id;
  const os = adOSThemeId();
  const lines = ['\n  Themes — Aura adOS palettes, worn by the TUI\n'];
  for (const t of allThemes()) lines.push(themeLine(t, t.id === active));
  if (os) lines.push('', FAINT(`  adOS is wearing "${os}" — :theme sync to follow it.`));
  lines.push('', FAINT(`  Choice saved to ${tilde(auraThemeFile())}`));
  emit(lines.join('\n'));
}

/**
 * Returns a result when `input` is :theme or starts with ':theme ', or null to
 * let the caller's remaining branches try it.
 */
export function handleThemeCommand(input: string): ReplCommandResult | null {
  if (input !== ':theme' && !input.startsWith(':theme ')
      && input !== ':themes' && !input.startsWith(':themes ')) return null;
  const cmd = input.startsWith(':themes') ? ':themes' : ':theme';
  const arg = input.slice(cmd.length).trim().toLowerCase();

  if (!arg || arg === 'list' || arg === 'ls') {
    listThemes();
    return { handled: true };
  }

  if (arg === 'help' || arg === '--help' || arg === '-h') {
    emit('\n  :theme — the TUI palette\n\n' + FAINT(USAGE) + '\n');
    return { handled: true };
  }

  if (arg === 'sync') {
    const os = adOSThemeId();
    if (!os) {
      emit('\n  ' + FAINT('adOS has no theme to follow — ~/.config/aura/theme is empty.') + '\n');
    } else if (!wear(os)) {
      emit('\n  ' + FAINT(`adOS wears "${os}", but no palette file for it is installed.`) + '\n');
    }
    return { handled: true };
  }

  if (arg === 'reset') {
    wear(DEFAULT_THEME_ID);
    return { handled: true };
  }

  if (!wear(arg)) {
    emit('\n  ' + FAINT(`No theme called "${arg}".`) + ' ' + FAINT(':theme lists them.') + '\n');
  }
  return { handled: true };
}
