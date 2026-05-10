/**
 * UniFi Protect API client routed through the UniFi Site Manager cloud API.
 * All requests go to api.ui.com with the X-API-KEY header.
 */

import type { Logger } from 'homebridge';

const CLOUD_BASE = 'https://api.ui.com';
const INTERESTING_TYPES = new Set(['motion', 'ring', 'smartDetectZone', 'smartDetectLine']);

export interface ProtectEvent {
  id: string;
  type: string;
  cameraId: string;
  cameraName: string;
  start: number;
  end: number | null;
  score: number;
  smartDetectTypes: string[];
  thumbnailB64?: string;
}

export class ProtectClient {
  private hostId?: string;
  private readonly cameras = new Map<string, string>();
  private readonly headers: Record<string, string>;

  constructor(
    apiKey: string,
    hostId?: string,
    private readonly log?: Logger,
  ) {
    this.hostId = hostId;
    this.headers = { 'X-API-KEY': apiKey, 'Accept': 'application/json' };
  }

  private protectUrl(path: string): string {
    return `${CLOUD_BASE}/v1/connector/consoles/${this.hostId}/proxy/protect/api${path}`;
  }

  private async resolveHostId(): Promise<void> {
    const res = await fetch(`${CLOUD_BASE}/v1/hosts`, { headers: this.headers });
    if (!res.ok) throw new Error(`GET /v1/hosts → ${res.status}`);
    const json = await res.json() as { data?: unknown[] } | unknown[];
    const hosts = (Array.isArray(json) ? json : (json as { data?: unknown[] }).data ?? []) as Array<{ id: string }>;
    if (!hosts.length) throw new Error('No UniFi consoles found under this API key.');
    if (hosts.length > 1) {
      const ids = hosts.map(h => h.id).join('\n  ');
      throw new Error(`Multiple consoles found — set hostId in Homebridge config:\n  ${ids}`);
    }
    this.hostId = hosts[0].id;
    this.log?.info('Auto-discovered console host ID: %s', this.hostId);
  }

  async loadCameras(): Promise<void> {
    if (!this.hostId) await this.resolveHostId();
    const res = await fetch(this.protectUrl('/bootstrap'), { headers: this.headers });
    if (!res.ok) throw new Error(`Bootstrap → ${res.status}`);
    const data = await res.json() as { cameras?: Array<{ id: string; name?: string }> };
    for (const cam of data.cameras ?? []) {
      this.cameras.set(cam.id, cam.name ?? cam.id);
    }
    this.log?.info('Loaded %d camera(s)', this.cameras.size);
  }

  getCameras(): Map<string, string> {
    return this.cameras;
  }

  async fetchEvents(sinceMs: number, untilMs: number): Promise<ProtectEvent[]> {
    const url = new URL(this.protectUrl('/events'));
    url.searchParams.set('start', String(sinceMs));
    url.searchParams.set('end', String(untilMs));
    const res = await fetch(url.toString(), { headers: this.headers });
    if (!res.ok) throw new Error(`Events → ${res.status}`);
    const raw = await res.json() as Array<Record<string, unknown>>;
    return raw
      .filter(e => INTERESTING_TYPES.has(e['type'] as string) && e['end'] != null)
      .map(e => ({
        id: e['id'] as string,
        type: e['type'] as string,
        cameraId: (e['camera'] as string) ?? '',
        cameraName: this.cameras.get((e['camera'] as string) ?? '') ?? (e['camera'] as string) ?? '',
        start: e['start'] as number,
        end: (e['end'] as number) ?? null,
        score: (e['score'] as number) ?? 0,
        smartDetectTypes: (e['smartDetectTypes'] as string[]) ?? [],
      }));
  }

  async fetchThumbnailB64(eventId: string): Promise<string | undefined> {
    const url = new URL(this.protectUrl(`/events/${eventId}/thumbnail`));
    url.searchParams.set('width', '640');
    try {
      const res = await fetch(url.toString(), { headers: this.headers });
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      return Buffer.from(buf).toString('base64');
    } catch {
      return undefined;
    }
  }
}
