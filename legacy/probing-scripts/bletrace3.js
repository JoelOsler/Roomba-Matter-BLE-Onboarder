/*
 * bletrace3.js — Maximum-granularity CoreBluetooth + network tracer
 *
 * Every BLE event is captured: char discovery (props + UUID), descriptor
 * discovery (CCCD presence), subscription attempts & results, reads,
 * writes (char + descriptor), notifications, read responses, RSSI, and
 * disconnect causes.  All HTTP and network calls are logged in full.
 * MatterSupport.framework is hooked if present.
 *
 * Run:
 *   frida -U -n "Roomba Home" -l bletrace3.js 2>&1 | tee ble_trace_$(date +%H%M%S).log
 */
'use strict';

// ── colour palette ────────────────────────────────────────────────────────────
const C = {
  rst:  '\x1b[0m',  gray: '\x1b[90m',  bold: '\x1b[1m',
  scan: '\x1b[95m', conn: '\x1b[33;1m', disc: '\x1b[36;1m',
  sub:  '\x1b[34;1m', wr: '\x1b[32;1m', rx: '\x1b[31;1m',
  net:  '\x1b[33m',   mx: '\x1b[35m',   err: '\x1b[31;1m',
  ok:   '\x1b[32m',   ts: '\x1b[90m',
};

var seq = 0;
function hdr(colour, tag) {
  return C.ts + (new Date().toISOString().slice(11,23)) + ' ' +
         C.gray + (++seq).toString().padStart(4,'0') + C.rst + ' ' +
         colour + tag + C.rst + ' ';
}

// ── byte helpers ──────────────────────────────────────────────────────────────
function nsDataToHex(ptr) {
  try {
    if (!ptr || ptr.isNull()) return '(null)';
    const o = new ObjC.Object(ptr);
    const len = o.length().valueOf();
    if (!len) return '(empty)';
    const bytes = new Uint8Array(Memory.readByteArray(o.bytes(), len));
    let hex = ''; let asc = '';
    for (const b of bytes) {
      hex += ('0' + b.toString(16)).slice(-2) + ' ';
      asc += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
    }
    return hex.trim() + '  |' + asc + '|';
  } catch(e) { return '(err:' + e.message + ')'; }
}

function nsStr(ptr) {
  try { return ptr && !ptr.isNull() ? new ObjC.Object(ptr).toString() : '(null)'; } catch { return '?'; }
}

function charShort(ptr) {
  try { return new ObjC.Object(ptr).UUID().UUIDString().toString().slice(4,8).toLowerCase(); } catch { return '????'; }
}
function charFull(ptr) {
  try { return new ObjC.Object(ptr).UUID().UUIDString().toString().toLowerCase(); } catch { return '?'; }
}

// CBCharacteristicProperties bitmask
const PROPS = [
  [0x001,'broadcast'],[0x002,'read'],[0x004,'writeNoRsp'],[0x008,'write'],
  [0x010,'notify'],[0x020,'indicate'],[0x040,'authSignWrite'],[0x080,'extProps'],
  [0x100,'notifyEncReq'],[0x200,'indicateEncReq'],
];
function propStr(v) {
  const n = typeof v === 'number' ? v : (v.toInt32 ? v.toInt32() : parseInt(v));
  return '0x' + n.toString(16).padStart(3,'0') + '[' +
    PROPS.filter(([m])=>n&m).map(([,nm])=>nm).join('|') + ']';
}

function errStr(ptr) {
  if (!ptr || ptr.isNull()) return null;
  try { return new ObjC.Object(ptr).localizedDescription().toString(); } catch { return 'ERROR'; }
}

if (!ObjC.available) { console.error('ObjC not available — attach to process first'); } else {

console.log(C.bold + '\n[bletrace3] Arming hooks...' + C.rst);

// ── 1. Central Manager state ──────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBCentralManager['- scanForPeripheralsWithServices:options:'].implementation, {
    onEnter(a) {
      let s = '(all)'; try { s = new ObjC.Object(a[2]).description().toString(); } catch{}
      console.log(hdr(C.scan,'[SCAN START]') + 'services: ' + s);
    }
  });
  Interceptor.attach(ObjC.classes.CBCentralManager['- stopScan'].implementation,
    { onEnter() { console.log(hdr(C.scan,'[SCAN STOP ]')); } });
} catch(e) { console.warn('scan: '+e.message); }

// ── 2. Connect / Disconnect ───────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBCentralManager['- connectPeripheral:options:'].implementation, {
    onEnter(a) {
      let name='?', uuid='?';
      try { const p=new ObjC.Object(a[2]); name=p.name()+''; uuid=p.identifier().UUIDString()+''; } catch{}
      console.log(hdr(C.conn,'[CONNECT   ]') + name + '  ' + uuid);
    }
  });
  Interceptor.attach(
    ObjC.classes.CBCentralManager['- cancelPeripheralConnection:'].implementation, {
    onEnter(a) {
      let uuid='?'; try { uuid=new ObjC.Object(a[2]).identifier().UUIDString()+''; } catch{}
      console.log(hdr(C.conn,'[DISCONNECT ]') + uuid);
    }
  });
} catch(e) { console.warn('connect: '+e.message); }

// didConnect / didDisconnect delegates (internal)
try {
  Interceptor.attach(
    ObjC.classes.CBCentralManager['- _didConnectPeripheral:'].implementation, {
    onEnter(a) {
      let n='?'; try { n=new ObjC.Object(a[2]).name()+''; } catch{}
      console.log(hdr(C.conn,'[CONNECTED ]') + n);
    }
  });
} catch{}
try {
  Interceptor.attach(
    ObjC.classes.CBCentralManager['- _didDisconnectPeripheral:error:'].implementation, {
    onEnter(a) {
      let n='?'; try { n=new ObjC.Object(a[2]).name()+''; } catch{}
      const e=errStr(a[3]);
      console.log(hdr(C.conn,'[DISCON CB ]') + n + (e?' err='+e:''));
    }
  });
} catch{}

// ── 3. Service Discovery ──────────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- discoverServices:'].implementation, {
    onEnter(a) {
      let s='(all)'; try { s=nsStr(a[2]); } catch{}
      console.log(hdr(C.disc,'[DISC SVC  ]') + s);
    }
  });
} catch{}

// ── 4. Characteristic Discovery ───────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _didDiscoverCharacteristicsForService:error:'].implementation, {
    onEnter(a) {
      try {
        const svc = new ObjC.Object(a[2]);
        const chars = svc.characteristics();
        const cnt = chars.count().valueOf();
        console.log(hdr(C.disc,'[DISC CHARS]') +
          'svc=' + svc.UUID().UUIDString().toString().slice(0,8).toLowerCase() +
          '  count=' + cnt);
        for (let i=0; i<cnt; i++) {
          const ch = new ObjC.Object(chars.objectAtIndex_(i));
          const uuid = ch.UUID().UUIDString().toString().toLowerCase();
          const props = propStr(ch.properties());
          console.log('  char[' + i.toString().padStart(2,'0') + '] ' +
            uuid.slice(4,8) + '  props=' + props);
        }
      } catch(e) { console.warn('disc chars: '+e.message); }
    }
  });
} catch{}

// ── 5. Descriptor Discovery ───────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- discoverDescriptorsForCharacteristic:'].implementation, {
    onEnter(a) {
      console.log(hdr(C.disc,'[DISC DESC ]') + 'char=' + charShort(a[2]));
    }
  });
} catch{}

try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _didDiscoverDescriptorsForCharacteristic:error:'].implementation, {
    onEnter(a) {
      try {
        const ch = new ObjC.Object(a[2]);
        const uuid = ch.UUID().UUIDString().toString().toLowerCase();
        const descs = ch.descriptors();
        const cnt = descs ? descs.count().valueOf() : 0;
        const list = [];
        for (let i=0; i<cnt; i++) {
          const d = new ObjC.Object(descs.objectAtIndex_(i));
          list.push(d.UUID().UUIDString().toString());
        }
        const hasCCCD = list.some(u => u==='2902'||u.startsWith('00002902'));
        console.log(hdr(C.disc,'[DISC DESC ]') +
          'char=' + uuid.slice(4,8) +
          '  descs=[' + (list.join(', ')||'none') + ']' +
          (hasCCCD ? '  ← HAS CCCD' : ''));
      } catch(e) { console.warn('disc desc cb: '+e.message); }
    }
  });
} catch{}

// ── 6. Subscribe / Unsubscribe ────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- setNotifyValue:forCharacteristic:'].implementation, {
    onEnter(a) {
      const enable = a[2].toInt32() !== 0;
      const uuid   = charFull(a[3]);
      let props = '?';
      try { props = propStr(new ObjC.Object(a[3]).properties()); } catch{}
      const tag = enable ? C.sub+'[SUBSCRIBE ]' : C.gray+'[UNSUB     ]';
      console.log(hdr(tag, '') + uuid.slice(4,8) + '  props=' + props +
        (enable ? '' : ' (disable)'));
    }
  });
} catch(e) { console.warn('sub: '+e.message); }

// Raw CCCD descriptor write (value = 0100 = notify, 0200 = indicate, 0000 = off)
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- writeValue:forDescriptor:'].implementation, {
    onEnter(a) {
      try {
        const desc = new ObjC.Object(a[3]);
        const descUuid = desc.UUID().UUIDString().toString();
        const charUuid = charFull(desc.characteristic());
        const data = nsDataToHex(a[2]);
        console.log(hdr(C.wr,'[WRITE DESC]') +
          'char=' + charUuid.slice(4,8) + '  desc=' + descUuid +
          '\n  data: ' + data);
      } catch(e) { console.warn('write desc: '+e.message); }
    }
  });
} catch{}

// Subscription result delegate
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _didUpdateNotificationStateForCharacteristic:error:'].implementation, {
    onEnter(a) {
      try {
        const ch = new ObjC.Object(a[2]);
        const uuid = ch.UUID().UUIDString().toString().toLowerCase();
        const notifying = ch.isNotifying();
        const e = errStr(a[3]);
        const status = e ? C.err+'FAIL '+e+C.rst : C.ok+'OK  isNotifying='+notifying+C.rst;
        console.log(hdr(C.sub,'[SUB RESULT]') + uuid.slice(4,8) + '  ' + status);
      } catch(e) { console.warn('sub result: '+e.message); }
    }
  });
} catch{}

// ── 7. Char Writes (app → robot) ─────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- writeValue:forCharacteristic:type:'].implementation, {
    onEnter(a) {
      const uuid = charFull(a[3]);
      const type = a[4].toInt32() === 0 ? 'withResponse' : 'withoutResponse';
      const data = nsDataToHex(a[2]);
      console.log(hdr(C.wr,'[WRITE CHR ]') +
        uuid.slice(4,8) + '  type=' + type +
        '\n  data: ' + data);
    }
  });
} catch(e) { console.warn('write: '+e.message); }

// Write acknowledgment
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _didWriteValueForCharacteristic:error:'].implementation, {
    onEnter(a) {
      try {
        const ch = new ObjC.Object(a[2]);
        const uuid = ch.UUID().UUIDString().toString().toLowerCase();
        const e = errStr(a[3]);
        console.log(hdr(C.wr,'[WRITE ACK ]') +
          uuid.slice(4,8) + '  ' + (e ? C.err+'ERR '+e+C.rst : C.ok+'ok'+C.rst));
      } catch(e) { console.warn('write ack: '+e.message); }
    }
  });
} catch{}

// ── 8. Reads ──────────────────────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- readValueForCharacteristic:'].implementation, {
    onEnter(a) {
      console.log(hdr(C.rx,'[READ REQ  ]') + charShort(a[2]));
    }
  });
} catch{}

// ── 9. Notifications + Read Responses ────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _handleNotifyValueWithCharacteristic:error:'].implementation, {
    onEnter(a) {
      try {
        const ch = new ObjC.Object(a[2]);
        const uuid = ch.UUID().UUIDString().toString().toLowerCase();
        const val  = ch.value();
        const data = nsDataToHex(val);
        const isNotify = ch.isNotifying();
        const e = errStr(a[3]);
        const tag = isNotify ? '[NOTIFY ←  ]' : '[VALUE ←   ]';
        console.log(hdr(C.rx, tag) + uuid.slice(4,8) +
          (e ? '  '+C.err+'ERR '+e+C.rst : '') +
          '\n  data: ' + data);
      } catch(e) { console.warn('notify: '+e.message); }
    }
  });
} catch(e) {
  // fallback: hook the value getter
  try {
    Interceptor.attach(ObjC.classes.CBCharacteristic['- value'].implementation, {
      onEnter(a) { this._char = a[0]; },
      onLeave(rv) {
        try {
          const uuid = charFull(this._char);
          console.log(hdr(C.rx,'[VALUE GET ]') + uuid.slice(4,8) + '  ' + nsDataToHex(rv));
        } catch{}
      }
    });
  } catch(e2) { console.warn('value: '+e2.message); }
}

// ── 10. RSSI ──────────────────────────────────────────────────────────────────
try {
  Interceptor.attach(
    ObjC.classes.CBPeripheral['- _didReadRSSI:error:'].implementation, {
    onEnter(a) {
      let rssi = '?'; try { rssi = new ObjC.Object(a[2]).toString(); } catch{}
      console.log(hdr(C.gray,'[RSSI      ]') + rssi + ' dBm');
    }
  });
} catch{}

// ── 11. NSURLSession — ALL requests ──────────────────────────────────────────
const urlHookTargets = [
  '- dataTaskWithRequest:completionHandler:',
  '- dataTaskWithURL:completionHandler:',
  '- uploadTaskWithRequest:fromData:completionHandler:',
];
for (const sel of urlHookTargets) {
  try {
    Interceptor.attach(ObjC.classes.NSURLSession[sel].implementation, {
      onEnter(a) {
        try {
          const arg = new ObjC.Object(a[2]);
          let url='?', method='GET', body='';
          try {
            if (arg.respondsToSelector_(ObjC.selector('URL'))) {
              url = arg.URL().absoluteString().toString();
              method = arg.HTTPMethod().toString();
              const bd = arg.HTTPBody();
              if (bd && !bd.isNull()) {
                const len = new ObjC.Object(bd).length().valueOf();
                body = '  body[' + len + ']';
              }
            } else {
              url = arg.absoluteString().toString();
            }
          } catch{}
          console.log(hdr(C.net,'[HTTP      ]') + method + ' ' + url + body);
        } catch(e) { console.warn('http: '+e.message); }
      }
    });
  } catch{}
}

// ── 12. MatterSupport.framework ───────────────────────────────────────────────
const matterHooks = {
  'MTRSetupPayload': [
    '- setPasscode:', '- setDiscriminator:', '- setRendezvousInformation:',
    '- initWithSetupPasscode:discriminator:',
    '+ payloadWithURL:', '+ payloadWithOnboardingPayload:error:',
  ],
  'MSMatterAddDeviceRequest': [
    '- initWithTopology:', '- init', '- start', '- cancel',
  ],
  'MSMatterAddDeviceExtensionRequestHandler': [
    '- validateDeviceCredential:completion:',
    '- selectWiFiNetwork:completion:',
    '- commissionDevice:completion:',
    '- rooms', '- home',
  ],
  'MTRCommissioningParameters': [
    '- setWifiSSID:', '- setWifiCredentials:', '- setWifi:',
  ],
  'MTRDeviceController': [
    '- pairDeviceWithID:discriminator:setupPINCode:error:',
    '- pairDeviceWithID:onboardingPayload:error:',
    '- getDeviceBeingCommissioned:error:',
  ],
};

for (const [cls, methods] of Object.entries(matterHooks)) {
  if (!ObjC.classes[cls]) continue;
  console.log(C.mx + '[bletrace3] ✓ Found MatterSupport class: ' + cls + C.rst);
  for (const m of methods) {
    try {
      Interceptor.attach(ObjC.classes[cls][m].implementation, {
        onEnter(a) {
          // Try to get any string arg
          let extra = '';
          try { extra = '  arg2=' + nsStr(a[2]).slice(0,80); } catch{}
          console.log(hdr(C.mx,'[MATTER    ]') + cls + ' → ' + m + extra);
        }
      });
    } catch{}
  }
}

// MTRSetupPayload property reads — captures discriminator + passcode values
try {
  if (ObjC.classes.MTRSetupPayload) {
    for (const getter of ['- passcode', '- discriminator', '- rendezvousInformation',
                          '- commissioningFlow', '- vendorID', '- productID',
                          '- setUpPINCode', '- setupPasscode']) {
      try {
        Interceptor.attach(ObjC.classes.MTRSetupPayload[getter].implementation, {
          onEnter(a) { this._self = a[0]; },
          onLeave(rv) {
            try {
              const v = rv.toInt32 ? rv.toInt32() : rv.toString();
              console.log(hdr(C.mx,'[PAYLOAD   ]') + 'MTRSetupPayload.' + getter.slice(2) + ' = ' + v);
            } catch{}
          }
        });
      } catch{}
    }
  }
} catch{}

// ── 13. iRobot app classes ────────────────────────────────────────────────────
// Scan for any class whose name contains "Matter", "BLE", "Commission", "Onboard"
const keywords = ['Matter','Ble','BLE','Commission','Onboard','Robot'];
let found = 0;
for (const name of Object.keys(ObjC.classes)) {
  if (keywords.some(k => name.includes(k)) && !name.startsWith('NS') &&
      !name.startsWith('CB') && !name.startsWith('MTR') && !name.startsWith('MS')) {
    if (found < 20) {
      console.log(C.mx + '[bletrace3] App class: ' + name + C.rst);
    }
    found++;
  }
}
if (found) console.log(C.mx + '[bletrace3] (' + found + ' app classes found)' + C.rst);

console.log(C.bold + '\n[bletrace3] All hooks armed ✓\n' + C.rst +
  '  Trigger Matter setup in Roomba Home app now.\n' +
  '  Key events to watch:\n' +
  '    [DISC CHARS] — char UUID + property bitmask\n' +
  '    [SUBSCRIBE ] — each setNotifyValue call\n' +
  '    [SUB RESULT] — OK/FAIL per char (non-notify ones will FAIL — that is normal)\n' +
  '    [WRITE CHR ] — any char write with data + type\n' +
  '    [WRITE ACK ] — server acknowledged write\n' +
  '    [NOTIFY ←  ] — inbound state notification (0x68, 0x64, 0x6b)\n' +
  '    [HTTP      ] — ALL network requests\n' +
  '    [MATTER    ] — MatterSupport.framework activity\n' +
  '    [PAYLOAD   ] — discriminator / passcode values\n');

} // ObjC.available
