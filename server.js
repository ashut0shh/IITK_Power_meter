// ============================================================
//  ESP32 Power Monitor — Multi-Tenant Alexa Skill Backend
//  Architecture:
//    Alexa → extracts amazonUserId
//    → lookup /users/{amazonUserId}/deviceId in Firebase
//    → read /devices/{deviceId}/telemetry
//    → read /devices/{deviceId}/config/params
//    → speak only enabled params
// ============================================================

const express   = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const Alexa     = require('ask-sdk-core');
const admin     = require('firebase-admin');

// ── Firebase Init ────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// ── Firebase Helpers ─────────────────────────────────────────

// Get the device ID that belongs to this Amazon user
async function getDeviceId(amazonUserId) {
  const snap = await db.ref(`/users/${amazonUserId}/deviceId`).once('value');
  return snap.val(); // e.g. "esp32_7A34B1" or null if not registered
}

// Get live telemetry for a device
async function getTelemetry(deviceId) {
  const snap = await db.ref(`/devices/${deviceId}/telemetry`).once('value');
  return snap.val();
}

// Get the list of enabled params for a device
// Falls back to all params if config not set
async function getEnabledParams(deviceId) {
  const snap = await db.ref(`/devices/${deviceId}/config/params`).once('value');
  return snap.val() || ['voltage', 'current', 'power', 'energy', 'frequency', 'pf', 'apparent_power'];
}

// Get device owner name for personalised responses
async function getOwnerName(deviceId) {
  const snap = await db.ref(`/devices/${deviceId}/config/ownerName`).once('value');
  return snap.val() || null;
}

// ── Core: resolve user → device → telemetry ──────────────────
async function resolveUser(amazonUserId) {
  const deviceId = await getDeviceId(amazonUserId);
  if (!deviceId) return { error: 'not_registered' };

  const [tel, params, ownerName] = await Promise.all([
    getTelemetry(deviceId),
    getEnabledParams(deviceId),
    getOwnerName(deviceId)
  ]);

  if (!tel) return { error: 'no_data', deviceId };

  return { deviceId, tel, params, ownerName };
}

// ── Format Helpers ────────────────────────────────────────────
function r1(n) { return Math.round(n * 10) / 10; }
function r2(n) { return Math.round(n * 100) / 100; }

function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} hours and ${m} minutes`;
  if (m > 0) return `${m} minutes`;
  return `${s % 60} seconds`;
}

// Build a speech string for a single param
function speakParam(param, tel) {
  switch (param) {
    case 'voltage':
      return `Voltage is ${r1(tel.voltage)} volts.`;
    case 'current':
      return `Current is ${r2(tel.current)} amperes.`;
    case 'power':
      return `Active power is ${r1(tel.power)} watts.`;
    case 'apparent_power':
      return `Apparent power is ${r1(tel.apparent_power)} volt-amperes.`;
    case 'energy':
      return `Energy used is ${r2(tel.energy)} watt-hours, or ${r2(tel.energy / 1000)} kilowatt-hours.`;
    case 'frequency':
      return `Grid frequency is ${r2(tel.frequency)} hertz.`;
    case 'pf':
      return `Power factor is ${r2(tel.pf)}.`;
    case 'uptime':
      return `Device uptime is ${fmtUptime(tel.uptime)}.`;
    default:
      return '';
  }
}

// ── Error speech helper ───────────────────────────────────────
function notRegisteredSpeech() {
  return `Your Amazon account is not linked to any device. 
          Please register your ESP32 using the setup app, then try again.`;
}

function noDataSpeech() {
  return `Your device is registered but not sending data right now. 
          Please check that your ESP32 is powered on and connected to WiFi.`;
}

function paramNotEnabled(param) {
  return `${param} is not enabled for your device. 
          Ask your administrator to add it to your device config.`;
}

// ── Intent Handlers ───────────────────────────────────────────

// LaunchRequest — summary on open
const LaunchHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);

    if (result.error === 'not_registered') {
      return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    }
    if (result.error === 'no_data') {
      return input.responseBuilder.speak(noDataSpeech()).getResponse();
    }

    const { tel, params, ownerName } = result;
    const greeting = ownerName ? `Hello ${ownerName}. ` : '';
    const summary = [];
    if (params.includes('power'))   summary.push(`${r1(tel.power)} watts`);
    if (params.includes('voltage')) summary.push(`${r1(tel.voltage)} volts`);
    if (params.includes('current')) summary.push(`${r2(tel.current)} amps`);

    const speech = `${greeting}Power monitor online. Current readings: ${summary.join(', ')}. What would you like to know?`;

    return input.responseBuilder
      .speak(speech)
      .reprompt('You can ask for power, voltage, current, energy, frequency, or a full report.')
      .getResponse();
  }
};

// GetPowerIntent
const GetPowerHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetPowerIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;
    if (!params.includes('power')) return input.responseBuilder.speak(paramNotEnabled('power')).getResponse();

    let speech = speakParam('power', tel);
    if (params.includes('apparent_power')) speech += ' ' + speakParam('apparent_power', tel);
    if (params.includes('pf'))             speech += ' ' + speakParam('pf', tel);

    return input.responseBuilder.speak(speech).getResponse();
  }
};

// GetVoltageIntent
const GetVoltageHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetVoltageIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;
    if (!params.includes('voltage')) return input.responseBuilder.speak(paramNotEnabled('voltage')).getResponse();

    const v = r1(tel.voltage);
    const status = v < 210 || v > 250 ? ' Warning: voltage is outside safe range!'
                 : v < 220 || v > 240 ? ' Voltage is slightly out of nominal range.'
                 : ' Voltage is nominal.';

    return input.responseBuilder.speak(`Voltage is ${v} volts.${status}`).getResponse();
  }
};

// GetCurrentIntent
const GetCurrentHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetCurrentIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;
    if (!params.includes('current')) return input.responseBuilder.speak(paramNotEnabled('current')).getResponse();

    return input.responseBuilder.speak(speakParam('current', tel)).getResponse();
  }
};

// GetEnergyIntent
const GetEnergyHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetEnergyIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;
    if (!params.includes('energy')) return input.responseBuilder.speak(paramNotEnabled('energy')).getResponse();

    return input.responseBuilder.speak(speakParam('energy', tel)).getResponse();
  }
};

// GetFrequencyIntent
const GetFrequencyHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetFrequencyIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;
    if (!params.includes('frequency')) return input.responseBuilder.speak(paramNotEnabled('frequency')).getResponse();

    let speech = speakParam('frequency', tel);
    if (params.includes('pf')) speech += ' ' + speakParam('pf', tel);

    return input.responseBuilder.speak(speech).getResponse();
  }
};

// GetAllIntent — only speaks enabled params
const GetAllHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetAllIntent';
  },
  async handle(input) {
    const userId = input.requestEnvelope.context.System.user.userId;
    const result = await resolveUser(userId);
    if (result.error === 'not_registered') return input.responseBuilder.speak(notRegisteredSpeech()).getResponse();
    if (result.error === 'no_data')        return input.responseBuilder.speak(noDataSpeech()).getResponse();

    const { tel, params } = result;

    // Speak params in a logical order, only if enabled
    const ORDER = ['voltage', 'current', 'power', 'apparent_power', 'pf', 'frequency', 'energy', 'uptime'];
    const parts = ['Full report.'];
    for (const param of ORDER) {
      if (params.includes(param)) {
        parts.push(speakParam(param, tel));
      }
    }

    return input.responseBuilder.speak(parts.join(' ')).getResponse();
  }
};

// Help
const HelpHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(input) {
    return input.responseBuilder
      .speak('You can ask: how many watts, what is the voltage, how many amps, how much energy, what is the frequency, or full report.')
      .reprompt('What would you like to know?')
      .getResponse();
  }
};

// Cancel / Stop
const CancelStopHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.CancelIntent'
       || Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(input) {
    return input.responseBuilder.speak('Power monitor offline.').getResponse();
  }
};

// Error handler
const ErrorHandler = {
  canHandle() { return true; },
  handle(input, error) {
    console.error('[Alexa Error]', error);
    return input.responseBuilder.speak('Something went wrong. Please try again.').getResponse();
  }
};

// ── Build skill ───────────────────────────────────────────────
const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchHandler,
    GetPowerHandler,
    GetVoltageHandler,
    GetCurrentHandler,
    GetEnergyHandler,
    GetFrequencyHandler,
    GetAllHandler,
    HelpHandler,
    CancelStopHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

// ── Express server ────────────────────────────────────────────
const app     = express();
const adapter = new ExpressAdapter(skill, true, true);

app.post('/alexa', adapter.getRequestHandlers());

app.get('/', (req, res) => {
  res.send('ESP32 Power Monitor — Multi-Tenant Alexa Backend ✓');
});

// ── Admin: register a user (call this once per new user) ──────
// POST /admin/register  { amazonUserId, deviceId, ownerName }
// Protect this route with a secret header in production
app.use(express.json());
app.post('/admin/register', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { amazonUserId, deviceId, ownerName } = req.body;
  if (!amazonUserId || !deviceId) {
    return res.status(400).json({ error: 'amazonUserId and deviceId required' });
  }

  await db.ref(`/users/${amazonUserId}`).set({ deviceId });
  await db.ref(`/devices/${deviceId}/config`).set({
    ownerName: ownerName || '',
    params: ['voltage', 'current', 'power', 'apparent_power', 'energy', 'frequency', 'pf', 'uptime']
  });

  res.json({ success: true, mapped: `${amazonUserId} → ${deviceId}` });
});

// Admin: update enabled params for a device
// POST /admin/params  { deviceId, params: ["voltage","power",...] }
app.post('/admin/params', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { deviceId, params } = req.body;
  if (!deviceId || !Array.isArray(params)) {
    return res.status(400).json({ error: 'deviceId and params[] required' });
  }

  await db.ref(`/devices/${deviceId}/config/params`).set(params);
  res.json({ success: true, deviceId, params });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
