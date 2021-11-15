import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SwitchBotPlatform } from '../platform';
import { interval, Subject } from 'rxjs';
import { skipWhile } from 'rxjs/operators';
import { DeviceURL, device, devicesConfig, serviceData, switchbot, deviceStatusResponse } from '../settings';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Contact {
  // Services
  private service: Service;
  private motionService: Service;
  private lightSensorService: Service;
  private batteryService?: Service;

  // Characteristic Values
  ContactSensorState!: CharacteristicValue;
  MotionDetected!: CharacteristicValue;
  CurrentAmbientLightLevel!: CharacteristicValue;
  BatteryLevel!: CharacteristicValue;
  StatusLowBattery!: CharacteristicValue;

  // OpenAPI others
  deviceStatus!: deviceStatusResponse;

  // BLE Others
  switchbot!: switchbot;
  serviceData!: serviceData;
  battery!: serviceData['battery'];
  movement!: serviceData['movement'];
  doorState!: serviceData['doorState'];
  lightLevel!: serviceData['lightLevel'];

  // Updates
  contactUbpdateInProgress!: boolean;
  doContactUpdate!: Subject<void>;

  constructor(
    private readonly platform: SwitchBotPlatform,
    private accessory: PlatformAccessory,
    public device: device & devicesConfig,
  ) {
    // default placeholders
    this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;

    // BLE Connection
    if (device.ble) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const SwitchBot = require('node-switchbot');
      this.switchbot = new SwitchBot();
      const colon = device.deviceId!.match(/.{1,2}/g);
      const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
      this.device.bleMac = bleMac.toLowerCase();
      this.platform.device(this.device.bleMac.toLowerCase());
    }

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doContactUpdate = new Subject();
    this.contactUbpdateInProgress = false;

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, 'SWITCHBOT-WOCONTACT-W1201500')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId!);

    // get the Contact service if it exists, otherwise create a new Contact service
    // you can create multiple services for each accessory
    (this.service =
      accessory.getService(this.platform.Service.ContactSensor) ||
      accessory.addService(this.platform.Service.ContactSensor)), `${accessory.displayName} Contact Sensor`;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // accessory.getService('NAME') ?? accessory.addService(this.platform.Service.Contact, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/MotionSensor
    (this.motionService =
      accessory.getService(this.platform.Service.MotionSensor) ||
      accessory.addService(this.platform.Service.MotionSensor)), `${accessory.displayName} Motion Sensor`;

    this.motionService.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Motion Sensor`);

    (this.lightSensorService =
      accessory.getService(this.platform.Service.LightSensor) ||
      accessory.addService(this.platform.Service.LightSensor)), `${accessory.displayName} Light Sensor`;

    this.lightSensorService.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Light Sensor`);

    if (device.ble) {
      (this.batteryService =
        accessory.getService(this.platform.Service.Battery) ||
        accessory.addService(this.platform.Service.Battery)), `${accessory.displayName} Battery`;

      this.batteryService.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Battery`);
    }

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.contactUbpdateInProgress))
      .subscribe(() => {
        this.refreshStatus();
      });
  }

  /**
   * Parse the device status from the SwitchBot api
   */
  async parseStatus() {
    if (this.device.ble) {
      this.platform.device('BLE');
      await this.BLEparseStatus();
    } else {
      this.platform.device('OpenAPI');
      await this.openAPIparseStatus();
    }
  }

  private async BLEparseStatus() {
    this.platform.debug('Contact BLE Device parseStatus');
    // Movement
    this.MotionDetected = Boolean(this.movement);
    // Door State
    switch (this.doorState) {
      case 'open':
      case 1:
        this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
        break;
      case 'close':
      case 0:
        this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
        break;
      default:
        this.platform.log.error('timeout no closed');
    }
    // Light Level
    switch (this.lightLevel) {
      case 'dark':
      case 0:
        this.CurrentAmbientLightLevel = 0.0001;
        break;
      default:
        this.CurrentAmbientLightLevel = 100000;
    }
    // Battery
    this.BatteryLevel = Number(this.battery);
    if (this.BatteryLevel < 10) {
      this.StatusLowBattery = this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      this.StatusLowBattery = this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    this.platform.debug(`${this.accessory.displayName}, ContactSensorState: ${this.ContactSensorState}, MotionDetected: ${this.MotionDetected}`
      + `CurrentAmbientLightLevel: ${this.CurrentAmbientLightLevel}, BatteryLevel: ${this.BatteryLevel}`);
  }

  private async openAPIparseStatus() {
    if (this.deviceStatus.body.openState === 'open') {
      this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
      this.platform.log.info(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    } else if (this.deviceStatus.body.openState === 'close') {
      this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
      this.platform.device(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    } else {
      this.platform.device(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    }
    this.MotionDetected = Boolean(this.deviceStatus.body.moveDetected);
    this.platform.debug(`${this.accessory.displayName}
    , ContactSensorState: ${this.ContactSensorState}, MotionDetected: ${this.MotionDetected}`);
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus() {
    if (this.device.ble) {
      this.platform.device('BLE');
      await this.BLERefreshStatus();
    } else {
      this.platform.device('OpenAPI');
      await this.openAPIRefreshStatus();
    }
  }

  private connectBLE() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Switchbot = require('node-switchbot');
    const switchbot = new Switchbot();
    const colon = this.device.deviceId!.match(/.{1,2}/g);
    const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
    this.device.bleMac = bleMac.toLowerCase();
    this.platform.device(this.device.bleMac!);
    return switchbot;
  }

  private async BLERefreshStatus() {
    this.platform.debug('Contact BLE Device RefreshStatus');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const switchbot = this.connectBLE();
    // Start to monitor advertisement packets
    switchbot.startScan({
      model: 'd',
      id: this.device.bleMac,
    }).then(() => {
      // Set an event hander
      switchbot.onadvertisement = (ad: any) => {
        this.serviceData = ad.serviceData;
        this.platform.device(`${this.device.bleMac}: ${JSON.stringify(ad.serviceData)}`);
        this.movement = ad.serviceData.movement;
        this.doorState = ad.serviceData.doorState;
        this.lightLevel = ad.serviceData.lightLevel;
        this.battery = ad.serviceData.battery;
        this.platform.device(`${this.accessory.displayName}, Movement: ${ad.serviceData.movement}, Door State: ${ad.serviceData.doorState},`
          + ` Light Level: ${ad.serviceData.lightLevel}, Battery: ${ad.serviceData.battery}`);
      };
      // Wait 10 seconds
      return switchbot.wait(10000);
    }).then(() => {
      // Stop to monitor
      switchbot.stopScan();
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    }).catch(async (e: any) => {
      this.platform.log.error(`BLE Connection Failed: ${e.message}`);
      this.platform.log.warn('Using OpenAPI Connection');
      await this.openAPIRefreshStatus();
    });
  }

  private async openAPIRefreshStatus() {
    try {
      this.deviceStatus = (await this.platform.axios.get(`${DeviceURL}/${this.device.deviceId}/status`)).data;
      this.platform.debug(`Contact ${this.accessory.displayName} refreshStatus: ${JSON.stringify(this.deviceStatus)}`);
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    } catch (e: any) {
      this.platform.log.error(`Contact ${this.accessory.displayName} failed to refresh status. Error Message: ${JSON.stringify(e.message)}`);
      this.platform.debug(`Contact ${this.accessory.displayName}, Error: ${JSON.stringify(e)}`);
      this.apiError(e);
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  updateHomeKitCharacteristics() {
    if (this.ContactSensorState === undefined) {
      this.platform.debug(`Contact ${this.accessory.displayName} ContactSensorState: ${this.ContactSensorState}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.ContactSensorState);
      this.platform.device(`Contact ${this.accessory.displayName} updateCharacteristic ContactSensorState: ${this.ContactSensorState}`);
    }
    if (this.MotionDetected === undefined) {
      this.platform.debug(`Contact ${this.accessory.displayName} MotionDetected: ${this.MotionDetected}`);
    } else {
      this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, this.MotionDetected);
      this.platform.device(`Contact ${this.accessory.displayName} updateCharacteristic MotionDetected: ${this.MotionDetected}`);
    }
    if (this.CurrentAmbientLightLevel === undefined) {
      this.platform.debug(`Contact ${this.accessory.displayName} CurrentAmbientLightLevel: ${this.CurrentAmbientLightLevel}`);
    } else {
      this.lightSensorService.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, this.CurrentAmbientLightLevel);
      this.platform.device(`Contact ${this.accessory.displayName} updateCharacteristic CurrentAmbientLightLevel: ${this.CurrentAmbientLightLevel}`);
    }
    if (this.BatteryLevel === undefined) {
      this.platform.debug(`Contact ${this.accessory.displayName} BatteryLevel: ${this.BatteryLevel}`);
    } else {
      this.batteryService?.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.BatteryLevel);
      this.platform.device(`Contact ${this.accessory.displayName} updateCharacteristic BatteryLevel: ${this.BatteryLevel}`);
    }
    if (this.StatusLowBattery === undefined) {
      this.platform.debug(`Contact ${this.accessory.displayName} StatusLowBattery: ${this.StatusLowBattery}`);
    } else {
      this.batteryService?.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, this.StatusLowBattery);
      this.platform.device(`Contact ${this.accessory.displayName} updateCharacteristic StatusLowBattery: ${this.StatusLowBattery}`);
    }
  }

  public apiError(e: any) {
    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, e);
    this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, e);
    this.lightSensorService.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, e);
    this.batteryService?.updateCharacteristic(this.platform.Characteristic.BatteryLevel, e);
    this.batteryService?.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, e);
  }
}