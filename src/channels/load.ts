import type { ChannelAdapter, ChannelConfig, ChannelEnv, ChannelModule } from "../core/channel.ts";

/** ".ts" when running from source, ".js" when running the built package. */
const extension = import.meta.url.slice(import.meta.url.lastIndexOf("."));

/**
 * Make the adapter for one channel entry of a bot. The type names a folder next to this file: "slack" loads
 * ./slack/index.ts. Adding a channel type is adding a folder; nothing else changes.
 */
export async function loadChannel(config: ChannelConfig, env: ChannelEnv): Promise<ChannelAdapter> {
  if (!/^[a-z0-9-]+$/.test(config.type)) throw new Error(`bad channel type ${JSON.stringify(config.type)}`);
  const module = (await import(new URL(`./${config.type}/index${extension}`, import.meta.url).href)) as ChannelModule;
  return module.createChannel(config, env);
}
