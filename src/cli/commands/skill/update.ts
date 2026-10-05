/**
 * `nextjs-harness skill update` — refresh the installed guidance from the
 * templates bundled with the current version of the package.
 */
import { logger } from '../../../logger.js';
import { reportSkillResult, runSkillInstall, type SkillCommandOptions } from './install.js';

export async function skillUpdateCommand(options: SkillCommandOptions = {}): Promise<void> {
  const outcomes = await runSkillInstall(options);
  reportSkillResult(outcomes, 'Updated');

  const changed = outcomes.flatMap((outcome) =>
    outcome.part.files.filter((file) => file.status === 'added' || file.status === 'updated'),
  );

  if (changed.length > 0) {
    const labels = outcomes.map((outcome) => outcome.target.label).join(', ');
    logger.print();
    logger.print(`Restart ${labels} to pick up the updated guidance.`);
  }
}