const { BF } = require('./models');

// Active (non-expired) BF record laata hai, ya null agar nahi hai / expire ho gaya
async function getActiveBF(telegramId) {
  const bf = await BF.findOne({ telegramId, expiresAt: { $gt: new Date() } }).lean();
  return bf || null;
}

// Chahe koi bhi message bhej raha ho, ye batata hai ki abhi ka active bf kaun hai (naam/nickname ke saath)
// Isse bot hamesha apne bf ko pehchanti hai - koi aur uska naam lekar bot ko uske khilaf gaali nahi dilwa sakta
async function getActiveBFIdentity() {
  const bf = await BF.findOne({ expiresAt: { $gt: new Date() } }).lean();
  return bf || null;
}

// Admin free mein 24h ke liye bf status deta hai (ya manually-verified UPI payment ke baad)
// Ek time pe sirf EK hi active bf ho sakta hai - naya set hote hi purana automatically hat jata hai
async function setBFByAdmin(telegramId, source = 'admin', name = '') {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Pehle sabhi purane bf records hata do (exclusivity - ek waqt mein ek hi bf)
  await BF.deleteMany({ telegramId: { $ne: telegramId } });

  return BF.findOneAndUpdate(
    { telegramId },
    { telegramId, source, ...(name ? { name } : {}), expiresAt },
    { upsert: true, new: true }
  );
}

// Saare currently-active bf users laata hai (good morning/night broadcast ke liye)
async function getAllActiveBFs() {
  return BF.find({ expiresAt: { $gt: new Date() } }).lean();
}

module.exports = { getActiveBF, getActiveBFIdentity, setBFByAdmin, getAllActiveBFs };