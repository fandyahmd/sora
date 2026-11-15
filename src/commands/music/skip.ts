import { Command, Declare, type CommandContext } from 'seyfert';
import { runControl } from '../../services/control.js';

@Declare({ name: 'skip', description: 'Skip to the next queued track' })
export default class SkipCommand extends Command {
  async run(ctx: CommandContext) {
    await runControl(ctx as never, 'skip');
  }
}
