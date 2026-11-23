import type { PlatformAdapter } from './adapters/types.ts';
import type { Store } from './store.ts';

export async function sdkUpdateCommand(platform: PlatformAdapter | undefined,
  switches: { on: boolean; off: boolean; now: boolean },
  store: Pick<Store, 'setSdkAutoUpdate'>, updateNow: (route: string) => Promise<string>): Promise<string> {
  if (!platform?.sdk) throw new Error('sdk-update requires a route with an SDK updater');
  if (Number(switches.on) + Number(switches.off) + Number(switches.now) !== 1)
    throw new Error('use exactly one of --on, --off, or --now');
  const caps = platform.capabilities;
  if (switches.now) return `${caps.id}: ${await updateNow(caps.id)}`;
  store.setSdkAutoUpdate(caps, switches.on);
  return `${caps.id}: SDK auto-update ${switches.on ? 'on' : 'off'}`;
}
