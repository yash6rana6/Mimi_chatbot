const { BF } = require('./models');

// Returns the active (non-expired) BF record, or null if none exists / expired
async function getActiveBF(telegramId) {
  const bf = await BF.findOne({ telegramId, expiresAt: { $gt: new Date() } }).lean();
  return bf || null;
}

// Regardless of who is sending a message, returns who the currently active bf is (with name/nickname)
// This lets the bot always recognize its bf - no one else can trick the bot into insulting them by name
async function getActiveBFIdentity() {
  const bf = await BF.findOne({ expiresAt: { $gt: new Date() } }).lean();
  return bf || null;
}

// Grants free 24h bf status via admin (or after manually-verified UPI payment)
// Only one active bf is allowed at a time - setting a new one automatically clears the old one
async function setBFByAdmin(telegramId, source = 'admin', name = '') {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Clear any previous bf records first (exclusivity - only one bf at a time)
  await BF.deleteMany({ telegramId: { $ne: telegramId } });

  return BF.findOneAndUpdate(
    { telegramId },
    { telegramId, source, ...(name ? { name } : {}), expiresAt },
    { upsert: true, new: true }
  );
}

// Fetches all currently-active bf users (for good morning/night broadcasts)
async function getAllActiveBFs() {
  return BF.find({ expiresAt: { $gt: new Date() } }).lean();
}

module.exports = { getActiveBF, getActiveBFIdentity, setBFByAdmin, getAllActiveBFs };