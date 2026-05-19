// ============================================================
//  ESP32 Power Monitor — Alexa Skill Backend
//  Host this on Glitch.com (free)
//  Reads telemetry from Firebase Realtime Database
// ============================================================

const express    = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const Alexa      = require('ask-sdk-core');
const admin      = require('firebase-admin');

// ── Firebase Init ────────────────────────────────────────────
// In Glitch: go to Tools → .env and add:
//   FIREBASE_DB_URL = https://esppowertest-default-rtdb.asia-southeast1.firebasedatabase.app
//   FIREBASE_SERVICE_ACCOUNT = { ...paste your service account JSON as one line... }
//
// To get the service account JSON:
//   Firebase Console → Project Settings → Service Accounts → Generate new private key

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// ── Fetch all telemetry from Firebase ────────────────────────
async function getTelemetry() {
  const snap = await db.ref('/telemetry').once('value');
  return snap.val();  // { voltage, current, power, energy, frequency, pf, apparent_power, uptime }
}

// ── Helpers ──────────────────────────────────────────────────
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} hours, ${m} minutes`;
  if (m > 0) return `${m} minutes, ${s} seconds`;
  return `${s} seconds`;
}

// ── Intent: LaunchRequest (just "open power monitor") ────────
const LaunchHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest';
  },
  async handle(input) {
    const tel = await getTelemetry();
    const speech = tel
      ? `Power monitor online. Current load is ${round1(tel.power)} watts at ${round1(tel.voltage)} volts. What would you like to know?`
      : `Power monitor is online but couldn't read sensor data right now. Try asking for power or voltage.`;
    return input.responseBuilder
      .speak(speech)
      .reprompt('You can ask for power, voltage, current, energy, or frequency.')
      .getResponse();
  }
};

// ── Intent: GetPower ─────────────────────────────────────────
const GetPowerHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetPowerIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const speech = `Active power is ${round1(tel.power)} watts. Apparent power is ${round1(tel.apparent_power)} volt-amperes. Power factor is ${round2(tel.pf)}.`;
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Intent: GetVoltage ───────────────────────────────────────
const GetVoltageHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetVoltageIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const status = tel.voltage < 210 || tel.voltage > 250
      ? 'Warning: voltage is outside safe range!'
      : tel.voltage < 220 || tel.voltage > 240
      ? 'Voltage is slightly out of nominal range.'
      : 'Voltage is nominal.';
    const speech = `Voltage is ${round1(tel.voltage)} volts. ${status}`;
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Intent: GetCurrent ───────────────────────────────────────
const GetCurrentHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetCurrentIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const speech = `Current draw is ${round2(tel.current)} amperes.`;
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Intent: GetEnergy ────────────────────────────────────────
const GetEnergyHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetEnergyIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const wh  = round2(tel.energy);
    const kwh = round2(tel.energy / 1000);
    const speech = `Energy consumed this session is ${wh} watt-hours, or ${kwh} kilowatt-hours.`;
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Intent: GetFrequency ─────────────────────────────────────
const GetFrequencyHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetFrequencyIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const speech = `Grid frequency is ${round2(tel.frequency)} hertz. Power factor is ${round2(tel.pf)}.`;
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Intent: GetAll (summary of everything) ───────────────────
const GetAllHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'GetAllIntent';
  },
  async handle(input) {
    const tel = await getTelemetry();
    if (!tel) return input.responseBuilder.speak("Couldn't reach the sensor. Please try again.").getResponse();
    const speech = [
      `Here's the full report.`,
      `Voltage: ${round1(tel.voltage)} volts.`,
      `Current: ${round2(tel.current)} amps.`,
      `Active power: ${round1(tel.power)} watts.`,
      `Power factor: ${round2(tel.pf)}.`,
      `Grid frequency: ${round2(tel.frequency)} hertz.`,
      `Session energy: ${round2(tel.energy)} watt-hours.`,
      `Uptime: ${fmtUptime(tel.uptime)}.`
    ].join(' ');
    return input.responseBuilder.speak(speech).getResponse();
  }
};

// ── Built-in: Help ────────────────────────────────────────────
const HelpHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(input) {
    const speech = `You can ask me things like: what's the power, what's the voltage, what's the current, how much energy, what's the frequency, or give me a full report.`;
    return input.responseBuilder.speak(speech).reprompt(speech).getResponse();
  }
};

// ── Built-in: Cancel / Stop ───────────────────────────────────
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

// ── Error handler ─────────────────────────────────────────────
const ErrorHandler = {
  canHandle() { return true; },
  handle(input, error) {
    console.error('[Alexa Error]', error);
    return input.responseBuilder
      .speak("Something went wrong. Please try again.")
      .getResponse();
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
const app      = express();
const adapter  = new ExpressAdapter(skill, true, true);  // verifySignature=true, checkTimestamp=true

app.post('/alexa', adapter.getRequestHandlers());

app.get('/', (req, res) => {
  res.send('ESP32 Power Monitor — Alexa backend is running ✓');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
