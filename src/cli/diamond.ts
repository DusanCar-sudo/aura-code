import chalk from 'chalk';

const r = chalk.hex('#9b1b30');
const g = chalk.hex('#c9a84c');
const w = chalk.hex('#f0ece4');

export function renderDiamond(): void {
  console.log(r('           / / /  \ \ \           '));
  console.log(w('          /__|____|__|__\          '));
  console.log(w('          \  |    |  | /          '));
  console.log(r('           \ \    / / /           '));
  console.log(r('            \ \  / //            '));
  console.log(r('             \ \/ //             '));
  console.log(g('              \  //              '));
  console.log(g('               \//               '));
  console.log(g('                V                '));
  console.log('');
}
