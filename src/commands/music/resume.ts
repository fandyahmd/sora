import { Command, Declare, type CommandContext } from 'seyfert';
import { runControl } from '../../services/control.js';

@Declare({ name: 'resume', description: 'Resume the paused track' })
export default class ResumeCommand extends Command {
  async run(ctx: CommandContext) {
    await runControl(ctx as never, 'resume');
  }
}
