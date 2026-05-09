import OpenAI from 'openai';
import type { Summarizer } from './summarizer.js';
import type { ProtectEvent } from './protectClient.js';

const MODEL = 'gpt-4o';

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

export class OpenAISummarizer implements Summarizer {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async summarise(event: ProtectEvent): Promise<string> {
    const userContent: OpenAI.ChatCompletionContentPart[] = [];

    if (event.thumbnailB64) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${event.thumbnailB64}`, detail: 'low' },
      });
    }
    userContent.push({ type: 'text', text: eventText(event) });

    const response = await this.client.chat.completions.create({
      model: MODEL,
      max_tokens: 256,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    return response.choices[0]?.message.content ?? '';
  }
}
