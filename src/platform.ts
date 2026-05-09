import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { CameraAccessory } from './cameraAccessory.js';
import { ProtectClient } from './protectClient.js';
import { ClaudeSummarizer } from './claudeSummarizer.js';

export class UnifiProtectClaudePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly cameraAccessories = new Map<string, CameraAccessory>();

  constructor(
    public readonly log: Logger,
    private readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    api.on('didFinishLaunching', () => this.init().catch(e => log.error(String(e))));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    const protect = new ProtectClient(
      this.config['apiKey'] as string,
      (this.config['hostId'] as string) || undefined,
      this.log,
    );
    const summarizer = new ClaudeSummarizer(this.config['anthropicApiKey'] as string);
    const pollInterval: number = (this.config['pollInterval'] as number) ?? 30;
    const motionDuration: number = (this.config['motionDuration'] as number) ?? 30;

    await protect.loadCameras();

    for (const [cameraId, cameraName] of protect.getCameras()) {
      const uuid = this.api.hap.uuid.generate(cameraId);
      const existing = this.cachedAccessories.get(uuid);
      const accessory = existing ?? new this.api.platformAccessory(cameraName, uuid);

      if (!existing) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }

      this.cameraAccessories.set(cameraId, new CameraAccessory(this, accessory, motionDuration));
    }

    let lastPollMs = Date.now() - pollInterval * 1000;

    const poll = async (): Promise<void> => {
      const nowMs = Date.now();
      try {
        const events = await protect.fetchEvents(lastPollMs, nowMs);
        lastPollMs = nowMs;
        for (const event of events) {
          event.thumbnailB64 = await protect.fetchThumbnailB64(event.id);
          const summary = await summarizer.summarise(event);
          this.cameraAccessories.get(event.cameraId)?.trigger(summary);
        }
      } catch (err) {
        this.log.error('Poll error: %s', String(err));
      }
      setTimeout(() => void poll(), pollInterval * 1000);
    };

    void poll();
  }
}
