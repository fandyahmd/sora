import { Command, Declare, type CommandContext } from 'seyfert';
import { runControl } from '../../services/control.js';

@Declare({ name: 'pause', description: 'Pause the current track' })
export default class PauseCommand extends Command {
  async run(ctx: CommandContext) {
    await runControl(ctx as never, 'pause');
  }
}
