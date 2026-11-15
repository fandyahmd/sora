import { Command, Declare, type CommandContext } from 'seyfert';
import { runControl } from '../../services/control.js';

@Declare({ name: 'stop', description: 'Stop playback, clear the queue, and disconnect' })
export default class StopCommand extends Command {
  async run(ctx: CommandContext) {
    await runControl(ctx as never, 'stop');
  }
}
