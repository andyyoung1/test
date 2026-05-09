import type { ProtectEvent } from './protectClient.js';

export interface Summarizer {
  summarise(event: ProtectEvent): Promise<string>;
}
