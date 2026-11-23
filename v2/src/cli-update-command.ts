import type { PlatformAdapter } from './adapters/types.ts';
import type { Store } from './store.ts';

export async function cliUpdateCommand(platform: PlatformAdapter | undefined,
  switches: { on: boolean; off: boolean; now: boolean },
  store: Pick<Store, 'setCliAutoUpdate'>, updateNow: (route: string) => Promise<string>): Promise<string> {
  if (!platform?.binaries || !platform.update) throw new Error('cli-update requires --route for a CLI with an official updater on this OS');
  if (Number(switches.on) + Number(switches.off) + Number(switches.now) !== 1)
    throw new Error('use exactly one of --on, --off, or --now');
  const caps = platform.capabilities;
  if (switches.now) return `${caps.id}: ${await updateNow(caps.id)}`;
  store.setCliAutoUpdate(caps, switches.on);
  return `${caps.id}: auto-update ${switches.on ? 'on' : 'off'}`;
}
