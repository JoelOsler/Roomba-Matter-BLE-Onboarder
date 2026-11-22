#!/usr/bin/env node
/**
 * commission-ble-setup.mjs — Roomba Matter BLE commissioning
 *
 * Protocol flow:
 *
 *  1. Assert Bluetooth adapter is powered on (fail fast: unsupported / off / unauthorized)
 *
 *  2. BLE scan — unfiltered Bluetooth scan using 'noble' + manual service UUID filter to avoid a
 *     macOS quirk where service-filtered scanning drops peripheral reports.
 *     Scans for SCAN_WINDOW_MS (5s), ranks results by RSSI, presents a numbered
 *     menu. User selects a robot (r = rescan, q = quit).
 *
 *  3. Connect to selected robot.
 *
 *  4. Discover all services + characteristics on the robot.
 *
 *  5. Attempt to subscribe to ALL characteristics in the iRobot service, in
 *     discovery order. noble's subscribe() writes to the CCCD; characteristics
 *     that don't support notify/indicate return an error which is silently swallowed
 *     (SUB-SKIP in --debug). In practice only the notify/indicate chars actually
 *     subscribe — but iterating all of them in discovery order is protocol-critical;
 *     the robot validates this CCCD-write sequence before accepting further commands.
 *
 *  6. Install a persistent state listener on c74e000c. All incoming notifications
 *     on that char are dispatched to a stateCallback slot used by later wait steps.
 *     Also installs debug-only notify loggers on all other chars.
 *
 *  7. READ device-info handshake — UUID order is protocol-specific:
 *       c74e0014 → {"ver":"4"}
 *       c74e0015 → {"hostname":"iRobot-<id>"}
 *       c74e0016 → {"sw":"p25-..."}
 *       c74e0017 → {"cap": ...}  (capabilities part 1)
 *       c74e0018 → {"cap": ...}  (capabilities part 2)
 *       c74e0019 → {"mac":"AA:BB:CC:DD:EE:FF"}
 *       c74e001a → {"proto":"mqtt"}
 *     After these reads the robot validates the client and begins sending
 *     state notifications on c74e000c.
 *
 *  8. READ c74e000c → 0x00 (init).
 *     Robot responds ~123 ms later with a 0x68 notification → POWER / CLEAN buttons fade in/out.
 *
 *  9. Wait for 0x64 on c74e000c (with a 60s timeout) — user presses POWER button on robot to prove physical access.
 *
 * 10. WRITE 0x67 to c74e000b  *withResponse*
 *     (ATT Write Request / CBCharacteristicWriteWithResponse) — signals intent to commission for Matter.
 *
 * 11. Wait for 0x6b on c74e000c (usually takes about 5s or less) (with a 30s timeout) — robot has entered Matter commissioning mode.
 *
 * 12. READ c74e0022 → uint16 LE — byte length of the onboarding JSON payload.
 *
 * 13. READ c74e0023 → UTF-8 JSON:
 *       {
            "startMatterCommissioning": {
              "onboardingPayload": {
                "discriminator": "<hex>",
                "passcode": "<hex>",
                "vendorId": "<hex>",
                "productId": "<hex>"
              }
            }
          }
 *
 *
 * 14. Disconnect from robot.
 *
 * 15. Parse JSON payload. All four fields are hex-encoded strings; parse with
 *     parseInt(value, 16).
 *
 * 16. Encode Matter manual pairing code (11-digit) via ManualPairingCodeCodec.
 *
 * 17. Encode Matter QR string (MT:...) via QrPairingCodeCodec:
 *       flowType = 2  (Custom commissioning process — requires Roomba Home app for initial robot setup and adjusting other robot settings)
 *       discoveryCapabilities = 0x07  (SoftAP | BLE | OnNetwork)
 *
 * 18. Render QR code in terminal + display manual code + Apple Home instructions.
 *
 * Usage:
 *   node commission-ble-setup.mjs [--debug]
 *
 *   --debug   Show timestamped BLE trace (characteristic UUIDs, raw state bytes,
 *             payload hex, timing info)
 */

import noble from '@abandonware/noble';
import readline from 'readline';
import { ManualPairingCodeCodec, QrPairingCodeCodec } from '@matter/types';
import qrTerm from 'qrcode-terminal';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const DEBUG = args.some(a => a === '--debug' || a === '-debug');

// ── GATT identifiers ──────────────────────────────────────────────────────────
const SVC          = 'c74edd21763c4e5485a843bb75035d75';

const CHAR_VER     = 'c74e0014763c4e5485a843bb75035d75';
const CHAR_HOST    = 'c74e0015763c4e5485a843bb75035d75';
const CHAR_SW      = 'c74e0016763c4e5485a843bb75035d75';
const CHAR_CAP1    = 'c74e0017763c4e5485a843bb75035d75';
const CHAR_CAP2    = 'c74e0018763c4e5485a843bb75035d75';
const CHAR_MAC     = 'c74e0019763c4e5485a843bb75035d75';
const CHAR_PROTO   = 'c74e001a763c4e5485a843bb75035d75';

const CHAR_CMD     = 'c74e000b763c4e5485a843bb75035d75'; // WRITE withResponse: 0x67
const CHAR_STATE   = 'c74e000c763c4e5485a843bb75035d75'; // INDICATE: state byte
const CHAR_IND1C   = 'c74e001c763c4e5485a843bb75035d75'; // INDICATE
const CHAR_IND1D   = 'c74e001d763c4e5485a843bb75035d75'; // INDICATE
const CHAR_SIZE    = 'c74e0022763c4e5485a843bb75035d75'; // READ: uint16 LE length
const CHAR_PAYLOAD = 'c74e0023763c4e5485a843bb75035d75'; // READ: JSON payload

const ST_READY     = 0x64;  // physical button pressed
const ST_MATTER    = 0x6b;  // Matter commissioning active

const CMD_MATTER   = Buffer.from([0x67]);

// Decode known state bytes
const STATE_LABEL = {
  0x00: 'init',     0x64: 'button-pressed', 0x65: 'error?',
  0x66: 'failed?',  0x68: 'BLE-connected/BUTTONS-fading',
  0x69: 'unknown-69', 0x6a: 'unknown-6a',  0x6b: 'Matter-active',
  0x6c: 'unknown-6c', 0x6e: 'aborted?',
};

// ── Output helpers ────────────────────────────────────────────────────────────
function dbg(tag, ...rest) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...rest);
}
const ui = (...a) => console.log(...a);

function rssiBar(rssi) {
  if (rssi == null) return '';
  if (rssi > -60)  return 'signal: ████  excellent';
  if (rssi > -70)  return 'signal: ███   good';
  if (rssi > -80)  return 'signal: ██    fair';
  return               'signal: █     weak';
}

// ── BLE helpers ───────────────────────────────────────────────────────────────
const readChar  = c => new Promise((ok, fail) => c.read((e, d) => e ? fail(e) : ok(d)));
const writeChar = (c, d) => new Promise((ok, fail) => c.write(d, false, e => e ? fail(e) : ok()));
const subChar   = c => new Promise((ok) => c.subscribe(e => {
  if (e) dbg('SUB-SKIP', `${c.uuid.slice(4,8)}: ${e.message || e}`);
  ok(); // always resolve — errors are non-fatal
}));
const findChar  = (chars, uuid) => chars.find(c => c.uuid === uuid);

// ── Clean exit — disconnect before quitting ───────────────────────────────────
let activePeripheral = null;
async function cleanExit(code = 0) {
  noble.stopScanning();
  if (activePeripheral) {
    dbg('EXIT', 'disconnecting…');
    try { activePeripheral.disconnect(); } catch {}
    await new Promise(r => setTimeout(r, 400)); // brief grace period
  }
  process.exit(code);
}
process.on('SIGINT',  () => { ui('\n  Disconnecting…'); cleanExit(0); });
process.on('SIGTERM', () => cleanExit(0));

// ── Robot selection ───────────────────────────────────────────────────────────
const SCAN_WINDOW_MS = 5_000;

async function pickRobot() {
  // Scan+select loop — typing r/rescan rescans without restarting the program.
  async function runScan() {
    // Scan window: unfiltered scan + manual service check avoids a macOS
    // quirk where service-UUID filtering + allowDuplicates drops peripheral reports.
    ui(`  Scanning for nearby Roomba robots (${SCAN_WINDOW_MS / 1000}s)…`);
    const found = new Map(); // id → peripheral

    await new Promise(resolve => {
      const onDiscover = p => {
        const svcs = (p.advertisement.serviceUuids || [])
          .map(s => s.toLowerCase().replace(/-/g, ''));
        if (!svcs.includes(SVC)) return; // not a Roomba, skip
        if (!found.has(p.id)) {          // keep first sighting (stable RSSI)
          found.set(p.id, p);
          dbg('FOUND', `${p.advertisement.localName || '?'} ${p.id}  rssi=${p.rssi}`);
        }
      };
      noble.startScanning([], false); // no service filter — we filter above
      noble.on('discover', onDiscover);
      setTimeout(() => {
        noble.stopScanning();
        noble.off('discover', onDiscover);
        resolve();
      }, SCAN_WINDOW_MS);
    });

    return [...found.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  let robots = await runScan();

  while (true) {
    if (robots.length === 0) {
      ui('  No Roomba robots found nearby — are they powered on? If so, remove the robot from the dock and try to reboot the robot.\n');
    } else {
      // Always show the list and prompt, even for a single robot
      const noun = robots.length === 1 ? '1 Roomba robot' : `${robots.length} Roomba robots`;
      ui(`\n  Found ${noun}:\n`);
      robots.forEach((p, i) => {
        const name = p.advertisement.localName || p.id;
        const bar  = rssiBar(p.rssi);
        ui(`    ${i + 1}.  ${name}`);
        ui(`        ${bar}`);
        ui(`        (Partial BLE Identifier: ${p.id.slice(0, 8).toUpperCase()}…)\n`);
      });
      ui('');
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const hint = robots.length > 0
      ? `  Select robot [1–${robots.length}], r to rescan, or q to quit: `
      : '  r to rescan, or q to quit: ';

    const choice = await new Promise(resolve => {
      const prompt = () => rl.question(hint, raw => {
        const answer = raw.trim().toLowerCase();
        if (answer === 'q' || answer === 'quit' || answer === 'exit') {
          rl.close(); ui(''); cleanExit(0); return;
        }
        if (answer === 'r' || answer === 'rescan') {
          rl.close(); resolve('rescan'); return;
        }
        if (robots.length > 0) {
          const n = parseInt(answer, 10);
          if (!isNaN(n) && n >= 1 && n <= robots.length) {
            rl.close(); resolve(n - 1); return;
          }
          ui(`  Please enter a number between 1 and ${robots.length}, r to rescan, or q to quit.`);
        } else {
          ui('  Please enter r to rescan or q to quit.');
        }
        prompt();
      });
      prompt();
    });

    if (choice === 'rescan') {
      ui('\n  Rescanning…');
      robots = await runScan();
      continue;
    }

    ui('');
    return robots[choice];
  }
}

// ── BLE flow ──────────────────────────────────────────────────────────────────
async function run() {
  ui('\n🤖  Roomba Matter Commissioner');
  ui('─'.repeat(44));
  if (DEBUG) ui('    debug mode on\n');

  ui('  ⚠️   Important — read before continuing setup:\n');
  ui('  This process resets the existing Matter pairing on your robot.');
  ui('  Any existing Matter pairing will stop working until you re-add');
  ui('  the robot to your Matter controller using the new pairing code');
  ui('  that will be generated here.\n');
  ui('  Tip: If your robot is already paired to a Matter controller and');
  ui('  you only need an additional pairing code (without resetting),');
  ui('  Consult your Matter controller\'s steps to "Turn on Pairing Mode"');
  ui('  to retrieve a fresh code without disturbing your existing setup.\n');
  ui('─'.repeat(44));
  ui('');

  // 1. Wait for BT power-on (or fail fast on unsupported/off)
  await new Promise((resolve, reject) => {
    const check = s => {
      if (s === 'poweredOn') return resolve();
      if (s === 'unsupported') return reject(new Error(
        'Bluetooth is not supported on this system.\n' +
        '  Linux: install BlueZ (sudo apt install bluetooth bluez)\n' +
        '  Windows: requires a supported BT adapter'
      ));
      if (s === 'poweredOff') return reject(new Error(
        'Bluetooth is turned off — please enable it and try again.'
      ));
      if (s === 'unauthorized') return reject(new Error(
        'Bluetooth access is unauthorized.\n' +
        '  macOS: grant Bluetooth access in System Settings → Privacy & Security\n' +
        '  Linux: run with sudo, or: sudo setcap cap_net_raw+eip $(which node)'
      ));
    };
    if (noble.state !== 'unknown') return check(noble.state);
    noble.once('stateChange', check);
  });
  dbg('BLE', 'powered on');

  // 2. Scan + pick robot
  let peripheral = await pickRobot();

  // Retry loop — re-entered on button timeout so the user can try again or
  // rescan without restarting the program.
  let intentionalDisconnect = false;
  let stateCallback = null;
  while (true) {
    ui(`  ✓  Selected: ${peripheral.advertisement.localName || peripheral.id}`);
    ui('  Connecting…');

    dbg('CONNECT', peripheral.advertisement.localName, peripheral.id);
    await new Promise((ok, fail) => {
      const timer = setTimeout(
        () => fail(new Error('Connection timed out — robot may be out of range or unresponsive')),
        15_000
      );
      peripheral.connect(e => { clearTimeout(timer); e ? fail(e) : ok(); });
    });
    activePeripheral = peripheral;
    intentionalDisconnect = false;
    peripheral.once('disconnect', () => {
      if (!intentionalDisconnect) { dbg('DISCONNECT'); process.exit(0); }
      dbg('DISCONNECT', 'intentional');
    });

    // 3. Discover services + characteristics
    await new Promise((ok, fail) =>
      peripheral.discoverAllServicesAndCharacteristics((e) => e ? fail(e) : ok())
    );

    const irobot_svc = peripheral.services.find(s => s.uuid === SVC);
    if (!irobot_svc) throw new Error(`Roomba service ${SVC} not found`);
    const allChars = irobot_svc.characteristics;

    dbg('DISC', `${allChars.length} chars in Roomba service (discovery order):`);
    dbg('DISC', allChars.map(c => c.uuid.slice(4,8) + '(' + c.properties.join(',') + ')').join(' '));

    const getChar = uuid => {
      const c = findChar(allChars, uuid);
      if (!c) throw new Error(`Char ${uuid.slice(4,8)} not found`);
      return c;
    };

    // 4. Subscribe to all three indicate characteristics.
    dbg('SUBSCRIBE', 'subscribing to c74e000c, c74e001c, c74e001d…');
    await subChar(getChar(CHAR_STATE));
    await subChar(getChar(CHAR_IND1C));
    await subChar(getChar(CHAR_IND1D));
    dbg('SUBSCRIBE', 'done');

    // 5. Install ONE persistent state listener (never removed)
    const stateChar = getChar(CHAR_STATE);
    stateCallback = null;
    stateChar.on('data', data => {
      const b = data[0];
      const label = STATE_LABEL[b] || `unknown-${b.toString(16).padStart(2,'0')}`;
      dbg('STATE', `0x${b.toString(16).padStart(2,'0')} (${label})`);
      if (stateCallback) stateCallback(b);
    });

    for (const c of allChars) {
      if (c.uuid === CHAR_STATE) continue;
      c.on('data', data => {
        dbg('NOTIFY', `char ${c.uuid.slice(4,8)} → 0x${data.toString('hex')}`);
      });
    }

    // 6. Device-info handshake reads (UUID order is protocol-specific)
    dbg('READ', 'device-info handshake…');
    const info = {};
    const ri = async (uuid, label, key) => {
      const buf = await readChar(getChar(uuid));
      let display;
      try { display = buf.toString('utf8'); } catch { display = buf.toString('hex'); }
      dbg('INFO', `${label} = ${display}`);
      if (key) info[key] = display;
    };

    await ri(CHAR_VER,   'ver',      null);
    await ri(CHAR_HOST,  'hostname', 'host');
    await ri(CHAR_SW,    'sw',       'sw');
    await ri(CHAR_CAP1,  'cap[1/2]', null);
    await ri(CHAR_CAP2,  'cap[2/2]', null);
    await ri(CHAR_MAC,   'mac',      'mac');
    await ri(CHAR_PROTO, 'proto',    null);

    const hostname = (info.host?.match(/"hostname":"([^"]+)"/) || [])[1] || '?';
    const swVer    = (info.sw?.match(/"sw":"([^"]+)"/)         || [])[1] || '?';
    const mac      = (info.mac?.match(/"mac":"([^"]+)"/)        || [])[1] || '?';

    ui('');
    ui('  ✓  Connected to Roomba');
    ui('  ◉  Device info:');
    ui(`  ✓  ${hostname}`);
    ui(`     Firmware ${swVer}  ·  ${mac}\n`);

    // 7. Read state char → robot emits 0x68 → LED fades
    const initBuf = await readChar(stateChar);
    dbg('STATE', `initial = 0x${initBuf.toString('hex')}`);

    ui('  ◉  Robot is ready for commissioning');
    ui('     Press the POWER button on your robot within 60 seconds…\n');

    // 8. Wait for button press (0x64) — resolve with 'ok' or 'timeout'
    const buttonResult = await new Promise(resolve => {
      const timer = setTimeout(() => { stateCallback = null; resolve('timeout'); }, 60_000);
      stateCallback = b => {
        if (b === ST_READY) { clearTimeout(timer); stateCallback = null; resolve('ok'); }
      };
    });

    if (buttonResult === 'timeout') {
      ui('  ✗  No button press detected within 60 seconds.\n');
      intentionalDisconnect = true;
      try { peripheral.disconnect(); } catch {}
      activePeripheral = null;
      await new Promise(r => setTimeout(r, 400));

      // Ask what to do next
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice = await new Promise(resolve => {
        const prompt = () => rl.question(
          '  [t] Try again  [r] Scan for a different robot  [q] Quit: ', raw => {
            const a = raw.trim().toLowerCase();
            if (a === 't' || a === 'try') { rl.close(); resolve('retry'); return; }
            if (a === 'r' || a === 'rescan') { rl.close(); resolve('rescan'); return; }
            if (a === 'q' || a === 'quit' || a === 'exit') { rl.close(); resolve('quit'); return; }
            ui('  Please enter t to try again, r to scan for a different robot, or q to quit.');
            prompt();
          }
        );
        prompt();
      });

      if (choice === 'quit') { ui(''); cleanExit(0); return; }
      if (choice === 'rescan') { peripheral = await pickRobot(); }
      // 'retry' reconnects to the same robot; 'rescan' picked a new one — either way loop back
      continue;
    }

    // Button was pressed — stash getChar for use below and exit the retry loop
    run._getChar = getChar;
    break;
  }

  const getChar = run._getChar;
  ui('  ✓  Button pressed — requesting Matter commissioning payload…');

  // 9. Write 0x67 to c74e000b withResponse (CBCharacteristicWriteWithResponse)
  dbg('WRITE', '→ c74e000b 0x67 (withResponse)');
  await writeChar(getChar(CHAR_CMD), CMD_MATTER);
  dbg('WRITE', 'acknowledged — waiting for 0x6b…');

  // 10. Wait for 0x6b (~5 s)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for commissioning mode (0x6b) after 30 s')),
      30_000
    );
    stateCallback = b => {
      if (b === ST_MATTER) { clearTimeout(timer); stateCallback = null; resolve(); }
    };
  });

  ui('  ✓  Commissioning active\n');

  // 11. Read payload size + JSON
  const sizeBuf = await readChar(getChar(CHAR_SIZE));
  const payloadLen = sizeBuf.readUInt16LE(0);
  dbg('SIZE', `${payloadLen} bytes`);

  const payloadBuf = await readChar(getChar(CHAR_PAYLOAD));
  const payloadStr = payloadBuf.toString('utf8');
  dbg('PAYLOAD', payloadStr);

  peripheral.disconnect();
  activePeripheral = null;

  // 12. Parse onboarding payload
  let parsed;
  try { parsed = JSON.parse(payloadStr); } catch (e) {
    throw new Error('JSON parse failed: ' + e.message + '\nRaw: ' + payloadStr);
  }
  const op = parsed?.startMatterCommissioning?.onboardingPayload;
  if (!op) throw new Error('No onboardingPayload in: ' + JSON.stringify(parsed));

  const discriminator = parseInt(op.discriminator, 16);
  const passcode      = parseInt(op.passcode,      16);
  const vendorId      = parseInt(op.vendorId,      16);
  const productId     = parseInt(op.productId,     16);

  dbg('MATTER', `discriminator=0x${discriminator.toString(16).toUpperCase()} (${discriminator})`);
  dbg('MATTER', `passcode=0x${passcode.toString(16).toUpperCase()} (${passcode})`);
  dbg('MATTER', `vendorId=0x${vendorId.toString(16).toUpperCase()}  productId=${productId}`);

  // 13. Generate pairing codes
  const manualCode = ManualPairingCodeCodec.encode({ discriminator, passcode, vendorId, productId });

  const qrString = QrPairingCodeCodec.encode([{
    version:               0,
    vendorId,
    productId,
    flowType:              2,  // Custom flow — requires Roomba Home app / MatterSupport.framework
    discoveryCapabilities: 7,  // SoftAP | BLE | OnNetwork
    discriminator,
    passcode,
  }]);

  // ── Display ───────────────────────────────────────────────────────────────
  // Right-side info lines, shown alongside the QR code
  const infoLines = [
    '',
    '  Add to Apple Home:',
    '',
    '  1. Open the Home app',
    '  2. Tap (+) → "Add Accessory"',
    '  3. Scan this QR code with your iPhone',
    '',
    `  Manual code:  ${manualCode}`,
    '',
    '  Robot will appear as "Matter Accessory"',
    '  — rename it however you like.',
    '',
    '  Not showing up?',
    '',
    '  Tap "More options…"',
    `  → "My Accessory Isn't Shown Here"`,
    '  → "Enter code…"',
    `  → type:  ${manualCode}`,
    '',
    `  QR string: ${qrString}`,
  ];

  qrTerm.generate(qrString, { small: true }, code => {
    const qrLines = code.split('\n');
    // Remove trailing empty line qrcode-terminal often appends
    while (qrLines.length && qrLines[qrLines.length - 1].trim() === '') qrLines.pop();

    const qrW     = Math.max(...qrLines.map(l => l.length));
    const gap     = '   ';
    // Centre the QR vertically within the info block — info runs top-to-bottom,
    // QR floats in the middle with info lines above and below it.
    const qrOffset = Math.floor((infoLines.length - qrLines.length) / 2);
    const total    = infoLines.length;

    const rows = [];
    for (let i = 0; i < total; i++) {
      const inQR = i >= qrOffset && i < qrOffset + qrLines.length;
      const qr   = (inQR ? qrLines[i - qrOffset] : '').padEnd(qrW);
      const info = infoLines[i] || '';
      rows.push(qr + gap + info);
    }
    ui('\n' + rows.join('\n') + '\n');
  });
}

run().catch(err => {
  console.error(`\n  ✗  ${err.message}`);
  if (DEBUG) console.error(err.stack);
  cleanExit(1);
});
