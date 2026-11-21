// ══════════════════════════════════════════════════════════════════════════════
//  Virtual Roomba Fleet — Web Bluetooth mock for offline testing
//
//  USAGE: paste this entire file into the browser DevTools console while the
//  page is open, then use the page normally.
//
//  ┌─ CHANGE THIS to test with more or fewer robots ────────────────────────┐
const ROBOT_COUNT = 5;
//  └────────────────────────────────────────────────────────────────────────┘
//
//  CONTROLS (run in console any time after injecting):
//    virtualRoomba.pressPower()        — fire power button on active robot
//    virtualRoomba.pressPower(index)   — fire on robot at index 0, 1, 2…
//    virtualRoomba.fleet               — array of all robot configs
//    virtualRoomba.restore()           — remove mock, restore real Bluetooth
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Timing shared by all robots ─────────────────────────────────────────────
  const TIMING = {
    connectDelay:      600,   // fake GATT connect latency (ms)
    powerButtonDelay: 3000,   // auto-fire "power button" after startNotifications
    matterDelay:      1200,   // delay from CMD 0x67 write to ST_MATTER response
  };

  // ── Auto-generate N distinct robot identities ───────────────────────────────
  function generateFleet(count) {
    return Array.from({ length: count }, (_, i) => {
      const n        = i + 1;
      const hexSeed  = n.toString(16).padStart(2, '0');
      // 32-char hostname hex: repeat the 2-char seed 16 times
      const hostHex  = hexSeed.repeat(16);
      const mac      = `AA:BB:CC:DD:EE:${hexSeed.toUpperCase()}`;
      const disc     = (0xA00 + i).toString(16).toUpperCase();       // 0xA00, 0xA01, …
      const pass     = (0x1337000 + i * 0x1111).toString(16).toUpperCase();
      return {
        index:         i,
        bleName:       `iRobot-Virtual-${n}`,
        hostname:      `iRobot-${hostHex}`,
        mac,
        firmware:      `23.1.0+Virtual${n}.s9`,
        vendorId:      '0x1234',
        productId:     '0x0001',
        discriminator: `0x${disc}`,
        passcode:      `0x${pass}`,
      };
    });
  }

  const FLEET = generateFleet(ROBOT_COUNT);

  // UUIDs (must match the page's constants)
  const CHAR_VER     = 'c74e0014-763c-4e54-85a8-43bb75035d75';
  const CHAR_HOST    = 'c74e0015-763c-4e54-85a8-43bb75035d75';
  const CHAR_SW      = 'c74e0016-763c-4e54-85a8-43bb75035d75';
  const CHAR_CAP1    = 'c74e0017-763c-4e54-85a8-43bb75035d75';
  const CHAR_CAP2    = 'c74e0018-763c-4e54-85a8-43bb75035d75';
  const CHAR_MAC     = 'c74e0019-763c-4e54-85a8-43bb75035d75';
  const CHAR_PROTO   = 'c74e001a-763c-4e54-85a8-43bb75035d75';
  const CHAR_CMD     = 'c74e000b-763c-4e54-85a8-43bb75035d75';
  const CHAR_STATE   = 'c74e000c-763c-4e54-85a8-43bb75035d75';
  const CHAR_IND1C   = 'c74e001c-763c-4e54-85a8-43bb75035d75';
  const CHAR_IND1D   = 'c74e001d-763c-4e54-85a8-43bb75035d75';
  const CHAR_SIZE    = 'c74e0022-763c-4e54-85a8-43bb75035d75';
  const CHAR_PAYLOAD = 'c74e0023-763c-4e54-85a8-43bb75035d75';

  const ST_READY  = 0x64;
  const ST_MATTER = 0x6b;

  function encText(str) {
    return new DataView(new TextEncoder().encode(str).buffer);
  }

  function log(msg, ...args) {
    console.log('%c[VirtualRoomba]%c ' + msg, 'color:#007AFF;font-weight:bold', 'color:inherit', ...args);
  }

  // ── Characteristic factory ───────────────────────────────────────────────────
  function makeChar(uuid, readFn) {
    const listeners = {};
    const char = {
      uuid,
      _fire(byteOrView) {
        const view = typeof byteOrView === 'number'
          ? new DataView(new Uint8Array([byteOrView]).buffer)
          : byteOrView;
        const evt = { target: { value: view } };
        (listeners['characteristicvaluechanged'] || []).forEach(fn => fn(evt));
      },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
      },
      startNotifications()  { return Promise.resolve(char); },
      stopNotifications()   { return Promise.resolve(char); },
      readValue()           { return Promise.resolve(readFn ? readFn() : encText('')); },
      writeValueWithResponse() { return Promise.resolve(); },
      writeValue()          { return Promise.resolve(); },
    };
    return char;
  }

  // ── Per-robot device factory ─────────────────────────────────────────────────
  function makeRobotDevice(cfg) {
    // Build characteristic map for this robot
    const chars = {
      [CHAR_VER]:     makeChar(CHAR_VER,     () => encText('1')),
      [CHAR_HOST]:    makeChar(CHAR_HOST,    () => encText(JSON.stringify({ hostname: cfg.hostname }))),
      [CHAR_SW]:      makeChar(CHAR_SW,      () => encText(JSON.stringify({ sw: cfg.firmware }))),
      [CHAR_CAP1]:    makeChar(CHAR_CAP1,    () => encText('1')),
      [CHAR_CAP2]:    makeChar(CHAR_CAP2,    () => encText('1')),
      [CHAR_MAC]:     makeChar(CHAR_MAC,     () => encText(JSON.stringify({ mac: cfg.mac }))),
      [CHAR_PROTO]:   makeChar(CHAR_PROTO,   () => encText('1')),
      [CHAR_SIZE]:    makeChar(CHAR_SIZE,    () => encText('1')),
      [CHAR_PAYLOAD]: makeChar(CHAR_PAYLOAD, () => encText(JSON.stringify({
        startMatterCommissioning: {
          onboardingPayload: {
            discriminator: cfg.discriminator,
            passcode:      cfg.passcode,
            vendorId:      cfg.vendorId,
            productId:     cfg.productId,
          }
        }
      }))),
      [CHAR_IND1C]: makeChar(CHAR_IND1C),
      [CHAR_IND1D]: makeChar(CHAR_IND1D),
    };

    // State characteristic — drives the state machine
    const cState = makeChar(CHAR_STATE);
    chars[CHAR_STATE] = cState;

    let powerButtonTimer = null;
    let powerButtonFired = false;

    cState.startNotifications = function () {
      log(`[${cfg.bleName}] State notifications started — auto power button in ${TIMING.powerButtonDelay}ms`);
      powerButtonFired = false;
      if (powerButtonTimer) clearTimeout(powerButtonTimer);
      powerButtonTimer = setTimeout(() => {
        if (!powerButtonFired) pressPower();
      }, TIMING.powerButtonDelay);
      return Promise.resolve(cState);
    };

    // CMD characteristic — reacts to 0x67
    const cCmd = makeChar(CHAR_CMD);
    chars[CHAR_CMD] = cCmd;
    cCmd.writeValueWithResponse = function (val) {
      const byte = (val instanceof Uint8Array ? val : new Uint8Array(val))[0];
      log(`[${cfg.bleName}] CMD → 0x${byte.toString(16).padStart(2, '0')}`);
      if (byte === 0x67) {
        setTimeout(() => {
          log(`[${cfg.bleName}] Firing ST_MATTER (0x6b) ✓`);
          cState._fire(ST_MATTER);
        }, TIMING.matterDelay);
      }
      return Promise.resolve();
    };
    cCmd.writeValue = cCmd.writeValueWithResponse;

    const server = {
      connected: false,
      getPrimaryService() {
        return Promise.resolve({
          getCharacteristic(uuid) {
            const c = chars[uuid];
            if (c) return Promise.resolve(c);
            return Promise.reject(new DOMException(`No characteristic ${uuid}`, 'NotFoundError'));
          }
        });
      },
      disconnect() {
        server.connected = false;
        if (powerButtonTimer) { clearTimeout(powerButtonTimer); powerButtonTimer = null; }
        log(`[${cfg.bleName}] GATT disconnected`);
      }
    };

    function pressPower() {
      if (powerButtonTimer) { clearTimeout(powerButtonTimer); powerButtonTimer = null; }
      powerButtonFired = true;
      cState._fire(ST_READY);
      log(`[${cfg.bleName}] Power button → ST_READY (0x64) ✓`);
    }

    const device = {
      id:   `virtual-roomba-${cfg.index}`,
      name: cfg.bleName,
      _cfg: cfg,
      _pressPower: pressPower,
      gatt: {
        get connected() { return server.connected; },
        connect() {
          log(`[${cfg.bleName}] Connecting…`);
          return new Promise(resolve => {
            setTimeout(() => {
              server.connected = true;
              log(`[${cfg.bleName}] GATT connected ✓`);
              resolve(server);
            }, TIMING.connectDelay);
          });
        }
      },
      addEventListener()    {},
      removeEventListener() {},
    };

    return device;
  }

  // ── Build the fleet of devices ───────────────────────────────────────────────
  const devices = FLEET.map(makeRobotDevice);

  // Round-robin index for "Add new" flows (no name filter)
  let pickIndex = 0;

  // ── Mock navigator.bluetooth ─────────────────────────────────────────────────
  const _realBluetooth = navigator.bluetooth;

  const mockBluetooth = {
    requestDevice(options) {
      // Re-onboard: page asks for a specific robot by name — find it in the fleet
      const nameFilter = options?.filters?.find(f => f.name)?.name;
      if (nameFilter) {
        const match = devices.find(d => d.name === nameFilter);
        if (match) {
          log(`requestDevice() → matched by name: "${match.name}"`);
          return Promise.resolve(match);
        }
        // Name not in fleet — fall through to round-robin (covers manuData filter fallback)
      }

      // "Add new" flow — return next robot in round-robin
      const device = devices[pickIndex % devices.length];
      log(`requestDevice() → fleet[${pickIndex % devices.length}]: "${device.name}"`);
      pickIndex++;
      return Promise.resolve(device);
    },
    getAvailability() { return Promise.resolve(true); },
  };

  Object.defineProperty(navigator, 'bluetooth', {
    get: () => mockBluetooth,
    configurable: true,
  });

  // ── Public API ────────────────────────────────────────────────────────────────
  window.virtualRoomba = {
    /**
     * Fire the power button on a robot.
     * No argument → fires on whichever robot was most recently picked.
     * Pass an index (0-based) to target a specific robot.
     */
    pressPower(index) {
      const i = (index === undefined) ? Math.max(0, (pickIndex - 1) % devices.length) : index;
      if (i >= devices.length) { log(`No robot at index ${i} (fleet has ${devices.length})`); return; }
      devices[i]._pressPower();
    },

    /** Array of all generated robot configs — inspect MACs, discriminators, etc. */
    fleet: FLEET,

    /** Remove the mock and restore real Web Bluetooth. */
    restore() {
      Object.defineProperty(navigator, 'bluetooth', {
        get: () => _realBluetooth,
        configurable: true,
      });
      log('Real navigator.bluetooth restored ✓');
    },

    /** Shared timing config — tweak delays live. */
    timing: TIMING,
  };

  // ── Startup banner ────────────────────────────────────────────────────────────
  console.log('');
  console.log(`%c✅ Virtual Roomba Fleet injected  (${ROBOT_COUNT} robot${ROBOT_COUNT !== 1 ? 's' : ''})`,
    'color:#34C759;font-size:14px;font-weight:bold');
  FLEET.forEach((r, i) =>
    console.log(`%c  [${i}] ${r.bleName}  MAC: ${r.mac}`, 'color:#8e8e93'));
  console.log('%c  Each "Add New" picks the next robot in order, then loops.', 'color:#8e8e93');
  console.log('%c  virtualRoomba.pressPower()     — fire power button (last picked robot)', 'color:#007AFF');
  console.log('%c  virtualRoomba.pressPower(i)    — fire on robot at index i', 'color:#007AFF');
  console.log('%c  virtualRoomba.fleet            — see all robot configs', 'color:#007AFF');
  console.log('%c  virtualRoomba.restore()        — remove mock', 'color:#007AFF');
  console.log('');

})();
