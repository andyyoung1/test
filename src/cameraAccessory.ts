import type { PlatformAccessory, Service } from 'homebridge';
import type { UnifiProtectClaudePlatform } from './platform.js';

export class CameraAccessory {
  private readonly motionService: Service;
  private motionResetTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly platform: UnifiProtectClaudePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly motionDuration: number,
  ) {
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(platform.Characteristic.Model, 'UniFi Protect Camera');

    this.motionService =
      accessory.getService(platform.Service.MotionSensor) ??
      accessory.addService(platform.Service.MotionSensor);
  }

  trigger(summary: string): void {
    this.platform.log.info('[%s] %s', this.accessory.displayName, summary);
    this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);

    if (this.motionResetTimer) clearTimeout(this.motionResetTimer);
    this.motionResetTimer = setTimeout(() => {
      this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, this.motionDuration * 1000);
  }
}
