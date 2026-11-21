# Roomba Matter Commissioner

A tool that pairs a Roomba robot with Apple Home, Home Assistant, or any Matter controller — without relying on the Roomba Home app.

iRobot quietly removed the Apple Home / Matter commissioning flow from version 3.1.0 of the Roomba Home app. This tool replicates that flow using Bluetooth, letting you generate a fresh Matter pairing code from any Matter compatible robot. (Edit: This feature has been added back as of 3.3.1)

---

## Web Tool (Recommended)

**No installation needed.** The commissioner runs entirely in your browser using the Web Bluetooth API — open the link below, pair your robot, and get a QR code and Setup PIN. Works on Desktop, Android, and iOS.

👉 **[Open the Roomba Matter Commissioner](https://joelosler.github.io/Roomba-Matter-BLE-Onboarder/)**

### Desktop

1. Open the link above in **Chrome or Edge** on macOS, Windows, or Linux
2. Click **Add Robot** and select your Roomba from the browser's Bluetooth picker
3. When prompted, press the **POWER** button on your robot to confirm physical access
4. Scan the QR code with your Matter controller (e.g. Apple Home) or enter the Setup PIN manually

### Mobile (Android)

1. Open the link above in **Chrome for Android**
2. Tap **Add Robot** — your phone's Bluetooth picker will appear
3. Press the **POWER** button on your robot when prompted
4. Scan the QR code with Apple Home, Google Home, or your Matter app of choice

### Mobile (iOS / iPadOS)

Safari does not support Web Bluetooth. Use **[Bluetooth Browser](https://apps.apple.com/app/id6455128847)** — a free app that adds Web Bluetooth support on iPhone and iPad (iOS 17+).

1. Install [Bluetooth Browser](https://apps.apple.com/app/id6455128847) from the App Store
2. Open the link above inside Bluetooth Browser
3. Tap **Add Robot** and select your Roomba from the picker
4. Press the **POWER** button on your robot when prompted
5. Scan the QR code with Apple Home or enter the Setup PIN manually

> **Browser support:** Chrome / Edge on desktop ✅ · Chrome on Android ✅ · Bluetooth Browser on iOS ✅ · Safari ❌ · Firefox ❌

---

| Matter Compatible iRobot Models |
|------|
Roomba Max 705 - Tested
Roomba Plus 500 Combo
Roomba Max 715 Series Vac
Roomba Max 775 Series Combo
Roomba Combo 10 Max

The models listed above are compatible with the Roomba Home app, and the Matter setup from app version 2.2.5, and brough back in version 3.3.1.

## Room & Zone Sharing

For your roomba's room and zone names to appear in your Matter controller (e.g. Apple Home), you need to grant iRobot your consent to share your map data. This can be done before or after Matter setup.

This step is not required to setup Matter, only to sync the room and zone names to Matter.
> **Note about revoking consent after setup**\
If consent is revoked after commissioning a robot, the previous room names will remain, and any changes made in the Roomba Home app will no longer sync to your Matter Controller. To resume room/zone name syncing, re-consent to share. (See "Granting Consent")

**1. Log in to your iRobot account**

Go to [irobot.com](https://www.irobot.com/en_US/login), sign in, then go to [My Account](https://www.irobot.com/en_US/account)

**2.** While signed in to [irobot.com](https://www.irobot.com/en_US/account), open the DevTools console (`⌥⌘I` on macOS · `F12` on Windows/Linux) and run one of the snippets below. A popup will confirm the result.

**Grant consent:**
```js
gigya.accounts.setAccountInfo({ data: { "HOME_KIT_MAP_DATA_SHARING_OPTIN": Date.now().toString() }, callback: () => gigya.accounts.getAccountInfo({ callback: r => alert(r.data.HOME_KIT_MAP_DATA_SHARING_OPTIN != 0 ? "Map sharing: Enabled" : "Map sharing: Disabled") }) })
```

---
**To remove or check consent status:**

**Revoke consent:**
```js
gigya.accounts.setAccountInfo({ data: { "HOME_KIT_MAP_DATA_SHARING_OPTIN": "0" }, callback: () => gigya.accounts.getAccountInfo({ callback: r => alert(r.data.HOME_KIT_MAP_DATA_SHARING_OPTIN != 0 ? "Map sharing: Enabled" : "Map sharing: Disabled") }) })
```

**Check status:**
```js
gigya.accounts.getAccountInfo({ callback: r => alert(r.data.HOME_KIT_MAP_DATA_SHARING_OPTIN != 0 ? "Map sharing: Enabled" : "Map sharing: Disabled") })
```

## Desktop / Legacy (Node.js)

> **This is the original prototype** used during reverse-engineering. The web tool above covers all the same functionality without any setup — use that instead unless you specifically need a local CLI or want to extend the tool.

**Prerequisites**

- [Node.js](https://nodejs.org/) 18 or later
- A Bluetooth adapter (built-in on most laptops)
- Your Roomba on its dock and powered on

**Libraries used**
- [@abandonware/noble](https://www.npmjs.com/package/@abandonware/noble)
- [@matter/types](https://www.npmjs.com/package/@matter/types)
- [qrcode-terminal](https://www.npmjs.com/package/qrcode-terminal)

**Platform notes**

| Platform | Notes |
|----------|-------|
| macOS | Requires Xcode |
| Linux | Requires BlueZ: `sudo apt install bluetooth bluez` |
| Windows | No setup required other than a compatible BLE adapter w/ driver |

**Setup**

```sh
git clone https://github.com/JoelOsler/Roomba-Matter-BLE-Onboarder
cd Roomba-Matter-BLE-Onboarder
npm install
```

**Usage**

```sh
npm start          # Run the commissioner
npm run debug      # Run with verbose BLE trace output
```

The tool scans for nearby Roomba robots, lets you select one, walks you through pressing the POWER button to confirm physical access, then outputs a Matter QR code and 8-digit Setup PIN ready to use with any Matter controller.

---

> [!WARNING]
>**This resets a robot's existing Matter pairing.** Any existing Matter controller pairing will stop working. Re-add the robot using the new code generated here. If you only need an *additional* pairing code without resetting, Consult your exsiting Matter controller's steps to "Turn on Pairing Mode"

---

## How It Works

Matter commissioning on a Roomba happens entirely over Bluetooth Low Energy using a proprietary Roomba GATT profile. The tool replicates the exact sequence the Roomba Home app performs:

**1. BLE Scan**

The tool performs an unfiltered BLE scan and manually filters for the Roomba service UUID (`C74EDD21-763C-4E54-85A8-43BB75035D75`).

**2. Connect and Discover**

After connecting, the tool discovers all services and characteristics on the robot. The Roomba service exposes 35 characteristics covering device info, state signalling, commands, and payload delivery, among other currently unknown characteristics.

**3. CCCD Subscriptions**

(Client Characteristic Configuration Descriptor)
The tool subscribes to the three characteristics that support indicate: `c74e000c` (state), `c74e001c`, and `c74e001d`. Initial captures suggested the robot might require a full sweep of all 35 characteristics in discovery order, but these three targeted subscriptions are all that's needed — the handshake completes and the robot responds normally.

**4. Device Info Handshake**

Seven characteristics are read: firmware version, hostname, software version, capabilities (two parts), MAC address, and protocol. Reading all of these values indicates to the robot we are ready to send a command.

**5. State machine**

Characteristic `c74e000c` carries a single-byte state value. The tool installs a persistent notify listener and waits for state transitions:

| Byte | Meaning |
|------|---------|
| `0x00` | Init |
| `0x68` | BLE connected — POWER/CLEAN buttons fade in (after `0x67` is sent to `c74e000b`) |
| `0x64` | POWER button pressed by user |
| `0x6b` | Matter commissioning payload is available |

**6. Trigger commissioning**

Once the user presses the POWER button (`0x64`), the tool writes `0x67` to characteristic `c74e000b`. This is to signal the robot to enter Matter commissioning mode.

**7. Payload retrieval**

After the robot transitions to `0x6b`, the tool reads `c74e0022` for the payload byte length, then reads `c74e0023` for the full JSON payload:

```json
{
  "startMatterCommissioning": {
    "onboardingPayload": {
      "discriminator": "<hex>",
      "passcode": "<hex>",
      "vendorId": "<hex>",
      "productId": "<hex>"
    }
  }
}
```

All four fields are hex-encoded strings. The tool parses them and encodes both into a QR string (`MT:...`) and an 11-digit manual pairing code using the `@matter/types` codec library.


---

## Reverse-Engineering the BLE Protocol

The Roomba GATT profile is fully undocumented. The protocol was reconstructed through the following techniques:

**CoreBluetooth hooking via Frida**\
A Frida script ([bletrace3.js](bletrace3.js)) was injected into the Roomba Home app on a Apple Silcon-based MacBook Pro to hook CoreBluetooth at the API level. Rather than capturing raw HCI packets, this intercepts the high-level delegate calls — `didDiscoverServices`, `didDiscoverCharacteristics`, `didUpdateValueForCharacteristic`, `didWriteValueForCharacteristic`, and so on — producing a clean, ordered complete log of every BLE operation the app performed: service discovery, CCCD subscriptions, characteristic reads, writes, and notify payloads, labelled with their UUIDs and values.

This log was then used to write a Node.js tool that emulates the same sequence with BLE using noble, without the Roomba Home app.

**State machine reconstruction**\
The single-byte state characteristic (`c74e000c`) was identified as the primary signalling channel by observing which characteristic emitted notifications at each stage of the app flow. Byte values were correlated against visible robot LED behaviour and app UI transitions to label each state (`0x68` = buttons fading, `0x64` = button pressed, `0x6b` = commissioning active).

**Write type identification**\
The commissioning trigger write to `c74e000b` was identified as an ATT Write Request (with response) rather than a Write Command (without response) by the presence of an ATT Write Response frame in the capture. In noble this maps to `characteristic.write(data, false, callback)` — the `false` flag selects the with-response path.

**CCCD subscriptions**\
Initial captures showed the Roomba Home app writing to every CCCD handle in discovery order before issuing any reads or commands, suggesting the robot validates this sweep as a client handshake. Further testing narrowed this down to the three characteristics that support indicate — `c74e000c`, `c74e001c`, and `c74e001d`. The robot knows we are connected and ready to send a command after these three are subscribed to.

During probing, only `c74e001c` was observed to emit a notification in practice; All three subscriptions are kept as a precaution — only subscribing to `c74e001c` caused intermittent failures in the commissioning process.

**Payload decoding**\
The JSON payload on `c74e0023` was identified by noticing a length-prefix read on `c74e0022` immediately before the large read on `c74e0023` — a common length-prefixed blob pattern. The payload was decoded as UTF-8 JSON, with hex-string encoding on the numeric fields confirmed by cross-checking the discriminator value against the QR code generated by the Roomba Home app.

---

## AI Disclosure

AI assistance was used in writing code during the reverse-engineering process and testing. All AI-generated code was manually reviewed and edited by a human developer before being executed or published.

## License

MIT — see [LICENSE](LICENSE).
