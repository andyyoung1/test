import Anthropic from '@anthropic-ai/sdk';
import type { ProtectEvent } from './protectClient.js';

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a home-security assistant that summarises camera events from a UniFi Protect system.

When given metadata and an optional thumbnail image for a single camera event, write a concise one-to-two sentence plain-English summary describing what happened. Focus on:
- Who or what was detected (person, vehicle, animal, package, etc.)
- Where in the frame they appeared, if discernible
- Any notable behaviour (walking, running, stationary, doorbell ring, etc.)

Keep the summary factual and neutral. Do not speculate beyond what is visible. If no image is provided, base the summary only on the metadata.`;

function eventText(event: ProtectEvent): string {
  const lines = [
    `Camera: ${event.cameraName}`,
    `Time: ${new Date(event.start).toISOString()}`,
    `Event type: ${event.type}`,
  ];
  if (event.smartDetectTypes.length) lines.push(`Smart detections: ${event.smartDetectTypes.join(', ')}`);
  if (event.score) lines.push(`Confidence score: ${event.score}%`);
  return lines.join('\n');
}

export class ClaudeSummarizer {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async summarise(event: ProtectEvent): Promise<string> {
    const content: Anthropic.MessageParam['content'] = [];

    if (event.thumbnailB64) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: event.thumbnailB64 },
      });
    }
    content.push({ type: 'text', text: eventText(event) });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
}
