/**
 * `nextjs-harness agent update` — refresh the installed role definitions from
 * the templates bundled with the current version of the package.
 */
import { logger } from '../../../logger.js';
import { reportAgentResult, runAgentInstall, type AgentCommandOptions } from './install.js';

export async function agentUpdateCommand(options: AgentCommandOptions = {}): Promise<void> {
  const outcomes = await runAgentInstall(options);
  reportAgentResult(outcomes, 'Updated');

  const changed = outcomes.flatMap((outcome) =>
    outcome.part.files.filter((file) => file.status === 'added' || file.status === 'updated'),
  );

  if (changed.length > 0) {
    const labels = outcomes.map((outcome) => outcome.target.label).join(', ');
    logger.print();
    logger.print(`Restart ${labels} to pick up the updated roles.`);
  }
}