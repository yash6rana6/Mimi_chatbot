const mongoose = require('mongoose');

// Har user ka record - rate limiting aur basic info ke liye
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: String,
  firstName: String,
  messageCount: { type: Number, default: 0 },
  lastResetDate: { type: String, default: () => new Date().toISOString().split('T')[0] },
  totalMessages: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now },
  // Daily chat streak tracking
  streakCount: { type: Number, default: 0 },
  lastStreakDate: String, // 'YYYY-MM-DD' format
});

// Chat history - context ke liye (last N messages store karenge per user)
const chatHistorySchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 3 }, // 3 din baad auto delete
});

// Group ki raw chat buffer - context ke liye taaki bot bina tag ke bhi samajh sake ki baat kya chal rahi hai
const groupMessageSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  username: String,
  content: { type: String, required: true },
  isBot: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 2 }, // 2 ghante baad auto delete
});

// Stickers - mood ke hisaab se saved stickers (admin /addsticker se add karega)
const stickerSchema = new mongoose.Schema({
  mood: { type: String, required: true, index: true }, // e.g. 'happy', 'sad', 'love', 'laugh'
  fileId: { type: String, required: true },
  addedBy: String,
  createdAt: { type: Date, default: Date.now },
});

// Dynamic admins - .env ke ADMIN_IDS ke alawa, koi bhi existing admin /addadmin se naye admin add kar sakta hai
const adminSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  addedBy: String,
  createdAt: { type: Date, default: Date.now },
});

// Partner ("bf") - admin isko special bana sakta hai FREE mein (24h), ya user khud ₹100 pay
// karke apne aap unlock kar sakta hai. Active hone par bot extra affectionate/gf-jaisa tone use karti hai.
const bfSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  nickname: String, // pet name jo bf khud set kar sakta hai (e.g. "jaanu")
  source: { type: String, enum: ['admin', 'payment'], default: 'admin' },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema);
const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);
const Sticker = mongoose.model('Sticker', stickerSchema);
const Admin = mongoose.model('Admin', adminSchema);
const BF = mongoose.model('BF', bfSchema);

module.exports = { User, ChatHistory, GroupMessage, Sticker, Admin, BF };