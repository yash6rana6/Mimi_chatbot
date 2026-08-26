require("dotenv").config();
const { Telegraf } = require("telegraf");
const mongoose = require("mongoose");
const sharp = require("sharp"); 
const {
  User,
  ChatHistory,
  GroupMessage,
  Sticker,
  Admin,
  Score,
  GroupMember,
  Feedback,
  DailyActivity,
  MatchPool,
} = require("./models");
const { getAIResponse, WAIFU_NAME, VALID_MOODS } = require("./ai");
const {
  pickReactionForText,
  reactToMessage,
  MOOD_TO_EMOJI,
} = require("./reactions");
const { getActiveBF, getActiveBFIdentity, setBFByAdmin } = require("./bf");
const { BF } = require("./models");
const { startScheduler } = require("./scheduler");
const { generateVoiceNote } = require("./voice");
const { ImageGenerator } = require("./imageGen");
const games = require("./games");
const extras = require("./extras");
const ttt = require("./ttt");

// Suppresses the Telegram "message is not modified" error
async function safeEditMessageText(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!err.description?.includes("message is not modified")) throw err;
  }
}

// Safety net: without this, an unhandled rejection ANYWHERE (e.g. Telegraf's
// own internal 90s per-update handler timeout firing while a slow image job
// is still running) crashes the entire Node process and takes the bot down.
process.on('unhandledRejection', (reason) => {
  console.error('🛑 Unhandled promise rejection (bot kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🛑 Uncaught exception (bot kept running):', err);
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  // Raise Telegraf's internal per-update processing timeout well above what
  // image generation can take. We also avoid awaiting slow image jobs inside
  // handlers (see generateAndSendImage call sites below), so this is mostly
  // a second layer of protection.
  handlerTimeout: 9_000_000,
});
const DAILY_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || "50");
const PROMO_LINK = process.env.PROMO_LINK;
const PROMO_TEXT = process.env.PROMO_TEXT || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GROUP_AUTO_REPLY = (process.env.GROUP_AUTO_REPLY || "true") === "true";
const GROUP_AUTO_REPLY_CHANCE = parseFloat(
  process.env.GROUP_AUTO_REPLY_CHANCE || "0.06",
);
const GROUP_AUTO_REPLY_COOLDOWN =
  parseInt(process.env.GROUP_AUTO_REPLY_COOLDOWN || "180") * 1000;

const VOICE_ENABLED = (process.env.VOICE_ENABLED || "false") === "true";
const VOICE_REPLY_CHANCE = parseFloat(process.env.VOICE_REPLY_CHANCE || "0.15");
const IMAGE_GEN_ENABLED = (process.env.IMAGE_GEN_ENABLED || "true") === "true";
const IMAGE_GEN_CHANCE = parseFloat(process.env.IMAGE_GEN_CHANCE || "0.3");
// Default model changed from the invalid "anything-v4.5" to a real Stable
// Horde model name. Override via .env if you want a different one.
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL || "Anything Diffusion";

const lastAutoReplyAt = new Map();
const activeQuizPolls = new Map();

// Initialize Image Generator
const imageGen = new ImageGenerator();

// Simple lock so we never try to run two generations at once (Horde rate-limits hard)
let isProcessingImage = false;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mentionHTML(user) {
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name || "Player")}</a>`;
}

// ---------- MongoDB Connect ----------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Helper Functions ----------
async function getOrCreateUser(ctx) {
  const telegramId = String(ctx.from.id);
  const today = new Date().toISOString().split("T")[0];

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = await User.create({
      telegramId,
      username: ctx.from.username || "",
      firstName: ctx.from.first_name || "",
    });
  }

  if (user.lastResetDate !== today) {
    user.messageCount = 0;
    user.lastResetDate = today;
  }

  return user;
}

async function isAdmin(ctx) {
  const userId = String(ctx.from.id);
  if (ADMIN_IDS.includes(userId)) return true;
  const found = await Admin.findOne({ telegramId: userId }).lean();
  return !!found;
}

function isOwnerAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

async function trackGroupMember(ctx) {
  try {
    await GroupMember.findOneAndUpdate(
      { chatId: String(ctx.chat.id), telegramId: String(ctx.from.id) },
      {
        username: ctx.from.username || "",
        firstName: ctx.from.first_name || "User",
        lastSeen: new Date(),
      },
      { upsert: true },
    );
  } catch (err) {
    console.error("trackGroupMember error:", err.message);
  }
}

async function addScore(chatId, telegramId, name, field, points = 10) {
  try {
    await Score.findOneAndUpdate(
      { chatId: String(chatId), telegramId: String(telegramId) },
      { $inc: { [field]: 1, points }, $set: { name } },
      { upsert: true },
    );
  } catch (err) {
    console.error("addScore error:", err.message);
  }
}

async function trackDailyActivity(ctx) {
  try {
    const today = new Date().toISOString().split("T")[0];
    await DailyActivity.findOneAndUpdate(
      {
        chatId: String(ctx.chat.id),
        telegramId: String(ctx.from.id),
        date: today,
      },
      { $inc: { count: 1 }, $set: { name: ctx.from.first_name || "User" } },
      { upsert: true },
    );
  } catch (err) {
    console.error("trackDailyActivity error:", err.message);
  }
}

// ============ IMAGE GENERATION ============

function shouldAutoGenerateImage(mood, userText, aiReply, aiImagePrompt) {
  if (!IMAGE_GEN_ENABLED) return false;

  // If AI explicitly requested an image via [IMAGE: ...]
  if (aiImagePrompt) return true;

  const triggerMoods = ["happy", "love", "laugh", "surprised", "excited", "romantic"];
  if (triggerMoods.includes(mood) && Math.random() < IMAGE_GEN_CHANCE) {
    return true;
  }

  const imageKeywords = [
    "picture", "photo", "image", "art", "draw", "sketch",
    "visual", "see", "show me", "generate", "make",
  ];
  const userLower = userText.toLowerCase();
  if (imageKeywords.some((kw) => userLower.includes(kw))) {
    return true;
  }

  return false;
}

function buildImagePrompt(mood, userText, aiReply, aiImagePrompt) {
  if (aiImagePrompt) {
    return `${aiImagePrompt}, high quality, detailed, beautiful anime style`;
  }

  const basePrompts = {
    happy: "happy cheerful joyful scene, bright colors, cute anime style",
    love: "romantic cute couple anime style, heart shapes, warm sunset, beautiful",
    laugh: "funny hilarious meme style, cartoon characters laughing, colorful",
    surprised: "shocked surprised expression, anime style, wide eyes, dramatic",
    neutral: "peaceful calm anime scenery, soft colors, relaxing vibe",
    sad: "melancholic beautiful anime sunset, emotional, touching",
    angry: "dramatic fierce anime character, intense colors, dynamic",
    excited: "exciting vibrant scene, sparkle, energetic, anime style",
    romantic: "romantic beautiful scenery, sunset, couple, anime style",
  };

  const moodBase = basePrompts[mood] || basePrompts.neutral;

  const words = userText.split(" ").slice(0, 6).join(" ");
  if (words && words.length > 10) {
    return `${words}, ${moodBase}, high quality, beautiful, anime style`;
  }

  return `${moodBase}, high quality, beautiful, anime style`;
}

// Single source of truth for sending a generated image. Tries several
// send methods (photo -> document -> compressed photo) so a Telegram-side
// rejection doesn't just silently fail. Returns true/false.
async function generateAndSendImage(ctx, prompt, caption, isGroup) {
  if (isProcessingImage) {
    await ctx.reply("⏳ I'm already generating an image, please wait a moment...");
    return false;
  }

  isProcessingImage = true;
  try {
    await ctx.sendChatAction("upload_photo");
    console.log(`🎨 Generating: "${prompt.substring(0, 60)}..."`);

    const base64Image = await imageGen.generateWithFallback(prompt, {
      width: 512,
      height: 512,
      model: IMAGE_GEN_MODEL,
      steps: 20,
      cfg_scale: 7,
    });

    let imageBuffer = Buffer.from(base64Image, "base64");
    if (imageBuffer.length === 0) {
      throw new Error("Empty image buffer");
    }
    console.log(`📊 Image size: ${(imageBuffer.length / 1024).toFixed(1)}KB`);

    // Normalize to a valid JPEG - Stable Horde sometimes returns WEBP,
    // which Telegram's photo endpoint can be picky about.
    try {
      imageBuffer = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
      console.log(`📊 Processed image size: ${(imageBuffer.length / 1024).toFixed(1)}KB`);
    } catch (sharpErr) {
      console.warn("Sharp processing failed, using original buffer:", sharpErr.message);
    }

    let sent = false;
    let lastError = null;

    // Method 1: send as photo
    try {
      await ctx.replyWithPhoto(
        { source: imageBuffer },
        {
          caption: caption.substring(0, 1000),
          reply_to_message_id: isGroup ? ctx.message.message_id : undefined,
          parse_mode: "HTML",
        },
      );
      sent = true;
      console.log("✅ Image sent as photo");
    } catch (photoErr) {
      lastError = photoErr;
      console.warn("Photo send failed:", photoErr.message);

      // Method 2: send as document
      try {
        await ctx.replyWithDocument(
          { source: imageBuffer, filename: "image.jpg" },
          {
            caption: caption.substring(0, 1000),
            reply_to_message_id: isGroup ? ctx.message.message_id : undefined,
            parse_mode: "HTML",
          },
        );
        sent = true;
        console.log("✅ Image sent as document");
      } catch (docErr) {
        lastError = docErr;
        console.warn("Document send failed:", docErr.message);

        // Method 3: compress harder and retry as photo
        try {
          const compressed = await sharp(imageBuffer)
            .jpeg({ quality: 60 })
            .resize(400, 400, { fit: "inside" })
            .toBuffer();

          await ctx.replyWithPhoto(
            { source: compressed },
            {
              caption: caption.substring(0, 1000) + "\n(compressed)",
              reply_to_message_id: isGroup ? ctx.message.message_id : undefined,
              parse_mode: "HTML",
            },
          );
          sent = true;
          console.log("✅ Image sent as compressed photo");
        } catch (compErr) {
          lastError = compErr;
          console.warn("Compressed send failed:", compErr.message);
        }
      }
    }

    if (!sent) {
      throw new Error(lastError?.message || "All send methods failed");
    }

    return true;
  } catch (err) {
    console.error("Image generation error:", err.message);

    let errorMsg = "❌ Couldn't generate image. ";
    if (err.message.includes("timeout")) {
      errorMsg = "⏳ No worker picked up the job in time — try again in a bit, or use a simpler prompt.";
    } else if (err.message.includes("Invalid image") || err.message.includes("Empty")) {
      errorMsg += "Image data was invalid. Try again!";
    } else if (err.message.toLowerCase().includes("rate limit") || err.message.includes("429")) {
      errorMsg = "⏳ Too many requests! Wait a bit and try again.";
    } else {
      errorMsg += "Try again in a moment!";
    }

    try {
      await ctx.reply(errorMsg);
    } catch (_) {}
    return false;
  } finally {
    isProcessingImage = false;
  }
}

// ---------- /gen command (manual test / on-demand generation) ----------
// IMPORTANT: this handler does NOT await the actual generation. Telegraf
// (and Telegram itself) expect update handlers to finish quickly; a slow
// public image queue (can be 5-15+ minutes) would otherwise trip internal
// timeouts and crash the process. We return immediately and let the image
// arrive whenever it's ready, as a separate message.
bot.command("gen", async (ctx) => {
  const prompt = ctx.message.text.replace("/gen", "").trim();
  if (!prompt) {
    return ctx.reply(
      "Give a prompt: /gen a beautiful sunset\n\nExample: /gen a cute cat wearing a hat",
    );
  }

  const msg = await ctx.reply(`🎨 Generating: "${prompt.substring(0, 30)}..." (this can take a while, I'll send it when it's ready)`);

  // Fire-and-forget: runs independently of this handler's lifecycle.
  generateAndSendImage(ctx, prompt, `🖼️ "${prompt}"`, false)
    .then(async (success) => {
      try {
        if (success) {
          await ctx.deleteMessage(msg.message_id);
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            undefined,
            "❌ Failed to generate image. Check the logs / try a different prompt!",
          );
        }
      } catch (_) {
        // Message may already be gone/too old to edit - not critical
      }
    })
    .catch((err) => {
      console.error("Background /gen error:", err.message);
    });
});

// ---------- Decide: whether to reply in the group ----------
function decideGroupReply(ctx) {
  const botUsername = ctx.botInfo.username;
  const text = ctx.message.text || "";
  const chatId = String(ctx.chat.id);

  if (text.includes(`@${botUsername}`))
    return { should: true, reason: "tagged" };
  if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id)
    return { should: true, reason: "tagged" };

  if (!GROUP_AUTO_REPLY) return { should: false, reason: null };

  const cooldownOk =
    Date.now() - (lastAutoReplyAt.get(chatId) || 0) > GROUP_AUTO_REPLY_COOLDOWN;
  if (!cooldownOk) return { should: false, reason: null };

  const nameRegex = new RegExp(`\\b${WAIFU_NAME}\\b`, "i");
  if (nameRegex.test(text)) {
    return { should: Math.random() < 0.7, reason: "name" };
  }

  if (text.trim().length < 8) return { should: false, reason: null };
  return { should: Math.random() < GROUP_AUTO_REPLY_CHANCE, reason: "random" };
}

// ---------- /start command ----------
bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    `Hiii! I'm ${WAIFU_NAME} 🌸\n\nChat freely in DM, tag me in groups or just say my name — I'm always listening 👀\n\nSo tell me, how's your day going?`,
  );
});

// ---------- /help ----------
const HELP_TEXT = `📖 How to use me:\n\n• Message me directly in DM\n• In a group, tag @{USERNAME}, say my name, or reply to my message\n• Sometimes I jump into the conversation myself 😄\n• {LIMIT} free messages per day\n\n/reset - I'll forget our past chat\n/mood - ask me my current mood\n/becomebf - special bf status for 24h\n/nickname <name> - (bf only) set your pet name\n/voice <text> - hear it from me as a voice message\n/gen <prompt> - generate an image\n\n🎮 Games:\n/games - menu of all games\n/truthordare - play Truth or Dare\n/wyr - Would You Rather\n/love <name1> and <name2> - compatibility calculator\n/quiz - trivia quiz\n/ttt - Tic-Tac-Toe (2 players)\n/leaderboard - this group's top scorers\n/matchme - matchmaker, find your match\n/feedback <msg> - send a suggestion/feedback\n/setbirthday DD-MM - set your birthday\n/qotd - Question of the Day\n/memberoftheday - today's top active member\n\n👑 Admin:\n/tagall <message> - mention everyone\n/broadcast <message/photo/video> - (owner only) send to all groups+DMs\n/groupcount - (owner only) how many groups I'm in\n/viewfeedback - (owner only) view recent feedback`;

async function sendHelp(ctx) {
  const text = HELP_TEXT.replace("{USERNAME}", ctx.botInfo.username).replace(
    "{LIMIT}",
    DAILY_LIMIT,
  );
  await ctx.reply(text);
}

bot.help(sendHelp);
bot.command("commands", sendHelp);

// ---------- /reset ----------
bot.command("reset", async (ctx) => {
  const telegramId = String(ctx.from.id);
  await ChatHistory.deleteMany({ telegramId });
  await ctx.reply(`Okay, forgot everything 🌸 Let's start fresh!`);
});

// ---------- /setbf ----------
bot.command("setbf", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("This command is admin-only 🙅‍♀️");
  }

  const parts = ctx.message.text
    .split(" ")
    .slice(1)
    .map((s) => s.trim());
  let targetId = parts[0] || "";
  const isPaid = parts.includes("paid");
  let targetName = "";

  if ((!targetId || targetId === "paid") && ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
    targetName = ctx.message.reply_to_message.from.first_name || "";
  }
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply(
      "Reply to someone with /setbf (or /setbf paid), or use /setbf 123456789 [paid]",
    );
  }

  if (!targetName) {
    try {
      const chatInfo = await ctx.telegram.getChat(targetId);
      targetName = chatInfo.first_name || "";
    } catch (err) {}
  }

  await setBFByAdmin(targetId, isPaid ? "payment" : "admin", targetName);
  await ctx.reply(
    `💕 ID ${targetId}${targetName ? ` (${targetName})` : ""} is now bf for the next 24 hours!${isPaid ? " (paid ✅)" : ""}`,
  );
});

// ---------- /becomebf ----------
bot.command("becomebf", async (ctx) => {
  const adminUsername = process.env.ADMIN_CONTACT_USERNAME;
  if (!adminUsername) {
    return ctx.reply(
      "This feature isn't available right now, ask the admin for /setbf 🙈",
    );
  }
  await ctx.reply(
    `💕 Want bf status for 24 hours?\n\nDM @${adminUsername} with your Telegram ID (${ctx.from.id}), they'll tell you how to activate it 🥰`,
  );
});

// ---------- /removebf ----------
bot.command("removebf", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("This command is admin-only 🙅‍♀️");
  }

  let targetId = (ctx.message.text.split(" ")[1] || "").trim();
  if (!targetId && ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
  }
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply(
      "Reply to someone with /removebf, or use /removebf 123456789",
    );
  }

  const result = await BF.deleteOne({ telegramId: targetId });
  if (result.deletedCount) {
    await ctx.reply(`💔 Removed bf status from ID ${targetId}.`);
  } else {
    await ctx.reply("They're not currently a bf.");
  }
});

// ---------- /voice ----------
bot.command("voice", async (ctx) => {
  if (!VOICE_ENABLED) {
    return ctx.reply("Voice feature is off right now 🙈");
  }
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) return ctx.reply("Give me some text too: /voice hii kaise ho tum");

  try {
    await ctx.sendChatAction("record_voice");
    const voiceBuffer = await generateVoiceNote(text);
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.error("Voice command error:", err.message);
    await ctx.reply("Had trouble generating the voice 🥺 try again in a bit");
  }
});

// ---------- /feedback ----------
bot.command("feedback", async (ctx) => {
  const message = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!message)
    return ctx.reply("What do you want to say? /feedback <message>");

  await Feedback.create({
    telegramId: String(ctx.from.id),
    name: ctx.from.first_name || "User",
    message,
  });
  await ctx.reply("Thank you! Noted your feedback 💌");
});

// ---------- /viewfeedback ----------
bot.command("viewfeedback", async (ctx) => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply("This command is owner-only 👑");
  }
  const recent = await Feedback.find().sort({ createdAt: -1 }).limit(15).lean();
  if (!recent.length) return ctx.reply("No feedback has come in yet.");

  const lines = recent.map((f) => `• ${f.name}: ${f.message}`).join("\n\n");
  await ctx.reply(`💌 Recent Feedback:\n\n${lines}`);
});

// ---------- /setbirthday ----------
bot.command("setbirthday", async (ctx) => {
  const input = (ctx.message.text.split(" ")[1] || "").trim();
  const match = input.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match)
    return ctx.reply(
      "Use the right format: /setbirthday DD-MM (e.g. /setbirthday 15-08)",
    );

  const day = parseInt(match[1]);
  const month = parseInt(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return ctx.reply("That date doesn't look valid, try again.");
  }

  const birthday = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  await User.findOneAndUpdate(
    { telegramId: String(ctx.from.id) },
    { birthday },
    { upsert: true },
  );
  await ctx.reply(`🎂 Set! I'll wish you that day 🎉`);
});

// ---------- /quote ----------
bot.command("quote", async (ctx) => {
  const quote = await extras.generateQuote();
  await ctx.reply(`✨ ${quote}`);
});

// ---------- /qotd ----------
bot.command("qotd", async (ctx) => {
  await ctx.reply(`💭 Question of the Day:\n\n${extras.getRandomQOTD()}`);
});

// ---------- /memberoftheday ----------
bot.command("memberoftheday", async (ctx) => {
  const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
  if (!isGroup) return ctx.reply("This command only works in groups.");

  const today = new Date().toISOString().split("T")[0];
  const top = await DailyActivity.findOne({
    chatId: String(ctx.chat.id),
    date: today,
  })
    .sort({ count: -1 })
    .lean();

  if (!top) return ctx.reply("No activity in this group yet today!");
  await ctx.reply(
    `🌟 Today's Member of the Day: ${top.name}!\n${top.count} messages sent today 🔥`,
  );
});

// ---------- /matchme ----------
bot.command("matchme", async (ctx) => {
  const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
  if (!isGroup) return ctx.reply("This command only works in groups.");

  const chatId = String(ctx.chat.id);
  const telegramId = String(ctx.from.id);
  const name = ctx.from.first_name || "Someone";

  const alreadyIn = await MatchPool.findOne({ chatId, telegramId });
  if (alreadyIn) {
    return ctx.reply(
      "You're already in the waiting pool! Wait for someone else to run /matchme 💌",
    );
  }

  const waitingPerson = await MatchPool.findOne({
    chatId,
    telegramId: { $ne: telegramId },
  });

  if (!waitingPerson) {
    await MatchPool.create({ chatId, telegramId, name });
    return ctx.reply(
      `💘 ${name} is looking for a match! Someone else run /matchme and you'll be paired up.`,
    );
  }

  await MatchPool.deleteOne({ chatId, telegramId: waitingPerson.telegramId });
  const { percent, message } = games.calculateLoveCompatibility(
    name,
    waitingPerson.name,
  );
  const bar =
    "💗".repeat(Math.round(percent / 10)) +
    "🖤".repeat(10 - Math.round(percent / 10));

  await ctx.reply(
    `🎉 Match found!\n\n💘 ${waitingPerson.name} + ${name}\n\n${bar}\n${percent}% match!\n\n${message}`,
  );
});

// ---------- /groupcount ----------
bot.command("groupcount", async (ctx) => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply("This command is owner-only 👑");
  }

  const groupCount = (await GroupMember.distinct("chatId")).length;
  const dmUserCount = (await User.distinct("telegramId")).length;

  await ctx.reply(
    `📊 Stats:\n\n👥 Groups I'm in: ${groupCount}\n💬 Total known users: ${dmUserCount}`,
  );
});

// ---------- /matchmaker ----------
bot.command("matchmaker", async (ctx) => {
  const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
  if (!isGroup) return ctx.reply("This command only works in groups.");

  const members = await GroupMember.find({
    chatId: String(ctx.chat.id),
  }).lean();
  if (members.length < 2) {
    return ctx.reply(
      "Need at least 2 members for matchmaking! Wait for a few more people to be active.",
    );
  }

  const shuffled = [...members].sort(() => Math.random() - 0.5);
  const [p1, p2] = shuffled;
  const { percent, message } = games.calculateLoveCompatibility(
    p1.firstName,
    p2.firstName,
  );
  const bar =
    "💗".repeat(Math.round(percent / 10)) +
    "🖤".repeat(10 - Math.round(percent / 10));

  await ctx.reply(
    `💘 Today's Matchmaking!\n\n${p1.firstName} + ${p2.firstName}\n\n${bar}\n${percent}% match!\n\n${message}`,
  );
});

// ---------- /broadcast ----------
async function runBroadcast(ctx, caption, photo, video) {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply("This command is owner-only 👑");
  }

  if (!caption && !photo && !video) {
    return ctx.reply(
      'Give a message too: /broadcast Hello everyone!\n\nOr send a photo/video with caption "/broadcast <text>", or reply to a photo/video with /broadcast.',
    );
  }

  const groupChatIds = await GroupMember.distinct("chatId");
  const userIds = await User.distinct("telegramId");
  const allTargets = [...new Set([...groupChatIds, ...userIds])];

  await ctx.reply(
    `📢 Sending broadcast to ${allTargets.length} chats, this'll take a bit...`,
  );

  let success = 0;
  let failed = 0;

  for (const chatId of allTargets) {
    try {
      if (photo) {
        await bot.telegram.sendPhoto(
          chatId,
          photo,
          caption ? { caption } : undefined,
        );
      } else if (video) {
        await bot.telegram.sendVideo(
          chatId,
          video,
          caption ? { caption } : undefined,
        );
      } else {
        await bot.telegram.sendMessage(chatId, caption);
      }
      success++;
    } catch (err) {
      failed++;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await ctx.reply(
    `✅ Broadcast complete!\n\nSent: ${success}\nFailed: ${failed}`,
  );
}

bot.command("broadcast", async (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const replied = ctx.message.reply_to_message;
  const photo = replied?.photo?.[replied.photo.length - 1]?.file_id;
  const video = replied?.video?.file_id;
  await runBroadcast(ctx, text, photo, video);
});

bot.on("photo", async (ctx) => {
  const caption = ctx.message.caption || "";
  if (!/^\/broadcast(\s|$)/i.test(caption)) return;
  const text = caption.split(" ").slice(1).join(" ").trim();
  const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  await runBroadcast(ctx, text, photo, null);
});

bot.on("video", async (ctx) => {
  const caption = ctx.message.caption || "";
  if (!/^\/broadcast(\s|$)/i.test(caption)) return;
  const text = caption.split(" ").slice(1).join(" ").trim();
  await runBroadcast(ctx, text, null, ctx.message.video.file_id);
});

// ---------- /tagall ----------
bot.command("tagall", async (ctx) => {
  const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
  if (!isGroup) return ctx.reply("This command only works in groups.");

  if (!(await isAdmin(ctx))) {
    return ctx.reply("This command is admin-only 🙅‍♀️");
  }

  const chatId = String(ctx.chat.id);
  const members = await GroupMember.find({ chatId }).lean();

  if (!members.length) {
    return ctx.reply(
      "No members tracked yet. They'll show up here once they send a message.",
    );
  }

  const customMsg = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const header = customMsg ? `📢 ${customMsg}\n\n` : "📢 Tagging everyone:\n\n";

  const BATCH_SIZE = 10;
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const mentions = batch
      .map((m) => `[${m.firstName || "User"}](tg://user?id=${m.telegramId})`)
      .join(" ");
    await ctx.reply(i === 0 ? header + mentions : mentions, {
      parse_mode: "Markdown",
    });
  }
});

// ---------- /leaderboard ----------
bot.command("leaderboard", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const top = await Score.find({ chatId })
    .sort({ points: -1 })
    .limit(10)
    .lean();

  if (!top.length) {
    return ctx.reply("No scores yet! Play some games: /games 🎮");
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((s, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} ${s.name} - ${s.points} pts (Quiz: ${s.quizWins}, TTT: ${s.tttWins})`;
  });

  await ctx.reply(`🏆 Leaderboard:\n\n${lines.join("\n")}`);
});

// ---------- /games ----------
bot.command("games", async (ctx) => {
  await ctx.reply("🎮 Games Menu - what do you want to play?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤔🔥 Truth or Dare", callback_data: "menu:truthordare" }],
        [{ text: "🆚 Would You Rather", callback_data: "menu:wyr" }],
        [{ text: "💘 Love Calculator", callback_data: "menu:love" }],
        [{ text: "❓ Quiz", callback_data: "menu:quiz" }],
        [{ text: "❌⭕ Tic-Tac-Toe", callback_data: "menu:ttt" }],
      ],
    },
  });
});

bot.action(/^menu:(.+)$/, async (ctx) => {
  const game = ctx.match[1];
  await ctx.answerCbQuery();

  if (game === "love") {
    return ctx.reply(
      "💘 Use it like: /love name1 and name2\n\nExample: /love Yash and Priya",
    );
  }

  if (game === "truthordare") {
    return ctx.reply("Truth or Dare? 😏", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🤔 Truth", callback_data: "tod:truth" },
            { text: "🔥 Dare", callback_data: "tod:dare" },
          ],
        ],
      },
    });
  }

  if (game === "wyr") {
    const q = games.getRandomWYR();
    return ctx.replyWithPoll("🆚 Would You Rather...", [q.a, q.b], {
      is_anonymous: false,
    });
  }

  if (game === "quiz") {
    const q = games.getRandomQuiz();
    const sentPoll = await ctx.replyWithPoll(q.q, q.options, {
      type: "quiz",
      correct_option_id: q.correct,
      is_anonymous: false,
      explanation: "Nice, well done! 🎉",
    });
    activeQuizPolls.set(sentPoll.poll.id, {
      chatId: String(ctx.chat.id),
      correctOptionId: q.correct,
    });
    return;
  }

  if (game === "ttt") {
    const chatId = ctx.chat.id;
    if (ttt.getGame(chatId)) {
      return ctx.reply(
        "A game is already running in this chat! Finish that one first.",
      );
    }
    ttt.startGame(chatId, ctx.from.id, ctx.from.first_name || "Player 1");
    return ctx.reply(
      `❌⭕ <b>Tic-Tac-Toe</b> started! ${mentionHTML(ctx.from)} issued a challenge.\n\nAny other player, hit "Join"!`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎮 Join Game", callback_data: `ttt_join:${chatId}` }],
          ],
        },
      },
    );
  }
});

// ---------- /truth ----------
bot.command("truth", async (ctx) => {
  await ctx.reply(
    `🤔 <b>Truth</b> for ${mentionHTML(ctx.from)}:\n\n${games.getRandomTruth()}`,
    {
      parse_mode: "HTML",
    },
  );
});

// ---------- /dare ----------
bot.command("dare", async (ctx) => {
  await ctx.reply(
    `🔥 <b>Dare</b> for ${mentionHTML(ctx.from)}:\n\n${games.getRandomDare()}`,
    {
      parse_mode: "HTML",
    },
  );
});

// ---------- /truthordare ----------
bot.command("truthordare", async (ctx) => {
  await ctx.reply(
    `🎲 <b>Truth or Dare</b>?\n\n${mentionHTML(ctx.from)}, pick one 😏`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🤔 Truth", callback_data: "tod:truth" },
            { text: "🔥 Dare", callback_data: "tod:dare" },
          ],
        ],
      },
    },
  );
});

bot.action(/^tod:(truth|dare)$/, async (ctx) => {
  const type = ctx.match[1];
  const result =
    type === "truth" ? games.getRandomTruth() : games.getRandomDare();
  const emoji = type === "truth" ? "🤔" : "🔥";
  const label = type === "truth" ? "Truth" : "Dare";
  await safeEditMessageText(
    ctx,
    `${emoji} <b>${label}</b> for ${mentionHTML(ctx.from)}:\n\n${result}`,
    { parse_mode: "HTML" },
  );
  await ctx.answerCbQuery();
});

// ---------- /wyr ----------
bot.command("wyr", async (ctx) => {
  const q = games.getRandomWYR();
  await ctx.replyWithPoll("🆚 Would You Rather...", [q.a, q.b], {
    is_anonymous: false,
  });
});

// ---------- /love ----------
bot.command("love", async (ctx) => {
  const parts = ctx.message.text
    .split(" ")
    .slice(1)
    .join(" ")
    .split(/\s+and\s+|\s*&\s*|\s*,\s*/i);
  let name1 = (parts[0] || "").trim();
  let name2 = (parts[1] || "").trim();

  if (!name1 || !name2) {
    return ctx.reply("Give two names: /love Yash and Priya");
  }

  const { percent, message } = games.calculateLoveCompatibility(name1, name2);
  const bar =
    "💗".repeat(Math.round(percent / 10)) +
    "🖤".repeat(10 - Math.round(percent / 10));

  await ctx.reply(
    `💘 <b>${escapeHtml(name1)}</b> + <b>${escapeHtml(name2)}</b>\n\n${bar}\n<b>${percent}% match!</b>\n\n${message}`,
    { parse_mode: "HTML" },
  );
});

// ---------- /quiz ----------
bot.command("quiz", async (ctx) => {
  const q = games.getRandomQuiz();
  const sentPoll = await ctx.replyWithPoll(q.q, q.options, {
    type: "quiz",
    correct_option_id: q.correct,
    is_anonymous: false,
    explanation: "Nice, well done! 🎉",
  });

  activeQuizPolls.set(sentPoll.poll.id, {
    chatId: String(ctx.chat.id),
    correctOptionId: q.correct,
  });
});

// ---------- Poll Answer Handler ----------
bot.on("poll_answer", async (ctx) => {
  const { poll_id, option_ids, user } = ctx.pollAnswer;
  const quizData = activeQuizPolls.get(poll_id);
  if (!quizData || !user) return;

  if (option_ids[0] === quizData.correctOptionId) {
    await addScore(
      quizData.chatId,
      user.id,
      user.first_name || "Player",
      "quizWins",
      10,
    );
  }
});

// ---------- /ttt ----------
bot.command("ttt", async (ctx) => {
  const chatId = ctx.chat.id;
  const existing = ttt.getGame(chatId);
  if (existing) {
    return ctx.reply(
      "A game is already running in this chat! Finish that one first.",
    );
  }

  ttt.startGame(chatId, ctx.from.id, ctx.from.first_name || "Player 1");
  await ctx.reply(
    `❌⭕ <b>Tic-Tac-Toe</b> started! ${mentionHTML(ctx.from)} issued a challenge.\n\nAny other player, hit "Join"!`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎮 Join Game", callback_data: `ttt_join:${chatId}` }],
        ],
      },
    },
  );
});

bot.action(/^ttt_join:(-?\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const game = ttt.joinGame(
    chatId,
    ctx.from.id,
    ctx.from.first_name || "Player 2",
  );
  if (!game) {
    return ctx.answerCbQuery(
      "Can't join this game (already full or it's your own game)",
      { show_alert: true },
    );
  }

  await ctx.answerCbQuery("Joined the game!");
  const p1Name = escapeHtml(game.names[game.players[0]]);
  const p2Name = escapeHtml(game.names[game.players[1]]);
  await safeEditMessageText(
    ctx,
    `❌ <b>${p1Name}</b> vs ⭕ <b>${p2Name}</b>\n\nCurrent turn: ${p1Name} (❌)`,
    { parse_mode: "HTML", reply_markup: ttt.buildKeyboard(chatId, game.board) },
  );
});

bot.action(/^ttt:(-?\d+):(\d)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const cellIndex = parseInt(ctx.match[2]);
  const result = ttt.makeMove(chatId, ctx.from.id, cellIndex);

  if (!result.success) {
    const messages = {
      no_game: "This game has already ended.",
      waiting_for_player: "Still waiting for the other player!",
      not_your_turn: "It's not your turn!",
      cell_taken: "That cell is already filled!",
    };
    return ctx.answerCbQuery(messages[result.reason] || "Invalid move", {
      show_alert: true,
    });
  }

  await ctx.answerCbQuery();

  const { winner, board, game } = result;
  const p1Name = escapeHtml(game?.names?.[game.players[0]] || "Player 1");
  const p2Name = escapeHtml(game?.names?.[game.players[1]] || "Player 2");

  if (winner === "draw") {
    await safeEditMessageText(ctx, `🤝 <b>Draw!</b> Well played both of you.`, {
      parse_mode: "HTML",
      reply_markup: ttt.buildKeyboard(chatId, board),
    });
  } else if (winner) {
    const winnerId = winner === "X" ? game.players[0] : game.players[1];
    const winnerName = winner === "X" ? p1Name : p2Name;
    await safeEditMessageText(
      ctx,
      `🎉 <b>${winnerName}</b> (${winner === "X" ? "❌" : "⭕"}) won! 🏆`,
      {
        parse_mode: "HTML",
        reply_markup: ttt.buildKeyboard(chatId, board),
      },
    );
    await addScore(chatId, winnerId, winnerName, "tttWins", 15);
  } else {
    const currentGame = ttt.getGame(chatId);
    const turnName = escapeHtml(currentGame.names[currentGame.turn]);
    const turnSymbol =
      currentGame.turn === currentGame.players[0] ? "❌" : "⭕";
    await safeEditMessageText(
      ctx,
      `❌ <b>${p1Name}</b> vs ⭕ <b>${p2Name}</b>\n\nCurrent turn: ${turnName} (${turnSymbol})`,
      {
        parse_mode: "HTML",
        reply_markup: ttt.buildKeyboard(chatId, board),
      },
    );
  }
});

// ---------- /nickname ----------
bot.command("nickname", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const bf = await getActiveBF(telegramId);
  if (!bf)
    return ctx.reply("This feature is only for my bf 🙈 Become bf first!");

  const nickname = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!nickname) return ctx.reply("Give a nickname too: /nickname jaanu");

  await BF.updateOne({ telegramId }, { nickname });
  await ctx.reply(`Okay ${nickname}! I'll call you that from now on 🥰`);
});

// ---------- /mood ----------
const MOOD_LINES = [
  {
    mood: "happy",
    text: "😁 In a really good mood right now, let's do something fun!",
  },
  { mood: "love", text: "🥰 Feeling a bit romantic today, was missing you" },
  { mood: "laugh", text: "😂 In a playful mood, tell me a joke!" },
  { mood: "sad", text: "🥺 Feeling a little low, talk to me" },
  { mood: "shy", text: "🥰 Feeling a bit shy today, not sure why" },
  {
    mood: "neutral",
    text: "😌 Chill mood, was just waiting for your messages",
  },
];
bot.command("mood", async (ctx) => {
  const pick = MOOD_LINES[Math.floor(Math.random() * MOOD_LINES.length)];
  await ctx.reply(pick.text);
});

// ---------- Admin Management ----------
bot.command("addadmin", async (ctx) => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply("This command is owner-only 👑");
  }

  const targetId = (ctx.message.text.split(" ")[1] || "").trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply(
      "Give a valid ID: /addadmin 123456789\n\nTo find someone's ID, ask them to check @userinfobot.",
    );
  }

  const already =
    ADMIN_IDS.includes(targetId) ||
    (await Admin.findOne({ telegramId: targetId }));
  if (already) return ctx.reply("They're already an admin.");

  await Admin.create({ telegramId: targetId, addedBy: String(ctx.from.id) });
  await ctx.reply(`✅ Made ID ${targetId} an admin!`);
});

bot.command("removeadmin", async (ctx) => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply("This command is owner-only 👑");
  }

  const targetId = (ctx.message.text.split(" ")[1] || "").trim();
  if (!targetId) return ctx.reply("Give a valid ID: /removeadmin 123456789");

  if (ADMIN_IDS.includes(targetId)) {
    return ctx.reply(
      "That's an owner admin (set in .env), can't be removed from the bot - has to be removed from .env directly.",
    );
  }

  const result = await Admin.deleteOne({ telegramId: targetId });
  if (result.deletedCount) {
    await ctx.reply(`✅ Removed ID ${targetId} from admins.`);
  } else {
    await ctx.reply("Couldn't find them in the admin list.");
  }
});

bot.command("listadmins", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("This command is admin-only 🙅‍♀️");
  }
  const dbAdmins = await Admin.find().lean();
  const lines = [
    ...ADMIN_IDS.map((id) => `${id} (owner)`),
    ...dbAdmins.map((a) => a.telegramId),
  ];
  await ctx.reply(`👑 Admins:\n${lines.join("\n")}`);
});

// ---------- Sticker Management ----------
bot.command("addsticker", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("This command is admin-only 🙅‍♀️");
  }

  const replied = ctx.message.reply_to_message;
  if (!replied || !replied.sticker) {
    return ctx.reply(
      "Reply to a sticker with: /addsticker happy\n\nMoods: " +
        VALID_MOODS.join(", "),
    );
  }

  const mood = (ctx.message.text.split(" ")[1] || "").toLowerCase();
  if (!VALID_MOODS.includes(mood)) {
    return ctx.reply("Give a valid mood: " + VALID_MOODS.join(", "));
  }

  await Sticker.create({
    mood,
    fileId: replied.sticker.file_id,
    addedBy: String(ctx.from.id),
  });
  await ctx.reply(`✅ Sticker saved in the "${mood}" category!`);
});

bot.command("removesticker", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ This command is admin-only 🙅‍♀️");
  }

  const replied = ctx.message.reply_to_message;
  if (!replied) {
    return ctx.reply(
      "📌 Reply to a sticker with /removesticker to remove it from my database.",
    );
  }

  if (!replied.sticker) {
    return ctx.reply("❌ Please reply to a sticker, not a text message.");
  }

  const fileId = replied.sticker.file_id;

  try {
    const existing = await Sticker.findOne({ fileId });
    if (!existing) {
      return ctx.reply(
        "❌ This sticker is not in my database. Use /addsticker to add it first.",
      );
    }

    const result = await Sticker.deleteOne({ fileId });

    if (result.deletedCount) {
      await ctx.reply(
        `✅ Sticker removed from the "${existing.mood}" category!`,
      );
    } else {
      await ctx.reply("❌ Something went wrong. Could not delete the sticker.");
    }
  } catch (err) {
    console.error("Remove sticker error:", err);
    await ctx.reply("❌ An error occurred while removing the sticker.");
  }
});

bot.command("stickers", async (ctx) => {
  const counts = await Sticker.aggregate([
    { $group: { _id: "$mood", count: { $sum: 1 } } },
  ]);
  if (!counts.length) return ctx.reply("No stickers saved yet.");
  const lines = counts.map((c) => `${c._id}: ${c.count}`).join("\n");
  await ctx.reply(`🎀 Saved stickers:\n${lines}`);
});

// ---------- Helper: send a random sticker based on mood ----------
async function maybeSendMoodSticker(ctx, mood) {
  if (Math.random() > 0.4) return;

  const stickers = await Sticker.aggregate([
    { $match: { mood } },
    { $sample: { size: 1 } },
  ]);
  if (!stickers.length) return;

  try {
    await ctx.replyWithSticker(stickers[0].fileId);
  } catch (err) {
    console.error("Sticker send error:", err.message);
  }
}

// ---------- React to sticker messages ----------
bot.on("sticker", async (ctx) => {
  const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
  if (isGroup) {
    const isReplyToBot =
      ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;
    if (!isReplyToBot) return;
  }
  await reactToMessage(ctx, "❤");
});

// ---------- Main Text Message Handler ----------
bot.on("text", async (ctx) => {
  try {
    const isGroup = ["group", "supergroup"].includes(ctx.chat.type);
    let groupReplyReason = null;

    if (isGroup) {
      const chatId = String(ctx.chat.id);
      const rawText = ctx.message.text || "";

      await GroupMessage.create({
        chatId,
        username: ctx.from.first_name || ctx.from.username || "Someone",
        content: rawText,
      });

      trackGroupMember(ctx);
      trackDailyActivity(ctx);

      const decision = decideGroupReply(ctx);
      if (!decision.should) return;
      groupReplyReason = decision.reason;
    }

    const user = await getOrCreateUser(ctx);

    if (user.messageCount >= DAILY_LIMIT && !(await isAdmin(ctx))) {
      await ctx.reply(
        `We've hit our ${DAILY_LIMIT} messages for today 🥺 We'll talk again tomorrow, promise!` +
          (PROMO_LINK ? `\n\n${PROMO_TEXT}\n${PROMO_LINK}` : ""),
      );
      return;
    }

    let userText = ctx.message.text
      .replace(`@${ctx.botInfo.username}`, "")
      .trim();

    const quickReaction = pickReactionForText(userText);
    if (quickReaction) await reactToMessage(ctx, quickReaction);

    try {
      await ctx.sendChatAction("typing");
    } catch (err) {
      if (
        err.description?.includes("CHAT_WRITE_FORBIDDEN") ||
        err.response?.description?.includes("CHAT_WRITE_FORBIDDEN")
      ) {
        return;
      }
      throw err;
    }

    let history;
    if (isGroup && groupReplyReason !== "tagged") {
      const recentGroupMsgs = await GroupMessage.find({
        chatId: String(ctx.chat.id),
      })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean();
      recentGroupMsgs.reverse();
      history = recentGroupMsgs.map((m) => ({
        role: "user",
        content: `${m.username}: ${m.content}`,
      }));
    } else {
      history = await ChatHistory.find({ telegramId: user.telegramId })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();
      history.reverse();
    }

    const ownerContext = {
      isOwner: ADMIN_IDS.includes(user.telegramId),
      ownerName: process.env.OWNER_NAME || "",
    };
    const bfIdentity = await getActiveBFIdentity();
    const {
      text: aiReply,
      mood,
      imagePrompt,
    } = await getAIResponse(
      history,
      userText,
      await getActiveBF(user.telegramId),
      ownerContext,
      bfIdentity,
    );

    // --- VOICE OR TEXT REPLY (sent immediately, never blocked by image gen) ---
    const sendAsVoice = VOICE_ENABLED && Math.random() < VOICE_REPLY_CHANCE;
    let voiceSent = false;

    if (sendAsVoice) {
      try {
        await ctx.sendChatAction("record_voice");
        const voiceBuffer = await generateVoiceNote(aiReply);
        await ctx.replyWithVoice(
          { source: voiceBuffer },
          { reply_to_message_id: isGroup ? ctx.message.message_id : undefined },
        );
        voiceSent = true;
      } catch (err) {
        console.error("Voice reply error:", err.message);
      }
    }

    if (!voiceSent) {
      await ctx.reply(aiReply, {
        reply_to_message_id: isGroup ? ctx.message.message_id : undefined,
      });
    }

    // --- AUTO IMAGE GENERATION ---
    // Runs in the background, detached from this handler. The public image
    // queue can take anywhere from seconds to many minutes, so we never
    // await it here - doing so risks tripping Telegraf's internal per-update
    // timeout and crashing the bot. The image (or a soft failure notice)
    // arrives as its own message whenever it's ready.
    if (shouldAutoGenerateImage(mood, userText, aiReply, imagePrompt)) {
      const prompt = buildImagePrompt(mood, userText, aiReply, imagePrompt);
      const caption = aiReply || "✨ Here's a visual for you!";
      const maxCaptionLength = 1000;
      const finalCaption =
        caption.length > maxCaptionLength
          ? caption.substring(0, maxCaptionLength - 30) + "..."
          : caption;

      generateAndSendImage(ctx, prompt, finalCaption, isGroup).catch((err) => {
        console.error("Background auto-image error:", err.message);
      });
    }

    if (isGroup) lastAutoReplyAt.set(String(ctx.chat.id), Date.now());

    if (!quickReaction) {
      await reactToMessage(ctx, MOOD_TO_EMOJI[mood]).catch(() => {});
    }

    await maybeSendMoodSticker(ctx, mood);

    await ChatHistory.create([
      { telegramId: user.telegramId, role: "user", content: userText },
      { telegramId: user.telegramId, role: "assistant", content: aiReply },
    ]);

    user.messageCount += 1;
    user.totalMessages += 1;

    const today = new Date().toISOString().split("T")[0];
    if (user.lastStreakDate !== today) {
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];
      user.streakCount =
        user.lastStreakDate === yesterday ? user.streakCount + 1 : 1;
      user.lastStreakDate = today;

      if (user.streakCount > 0 && user.streakCount % 7 === 0) {
        await ctx.reply(
          `🔥 Wow! You've talked to me for ${user.streakCount} days straight, proud of you!`,
        );
      }
    }

    await user.save();

    if (PROMO_LINK && user.totalMessages % 15 === 0) {
      await ctx.reply(`✨ ${PROMO_TEXT}\n${PROMO_LINK}`);
    }
  } catch (err) {
    if (
      err.description?.includes("CHAT_WRITE_FORBIDDEN") ||
      err.response?.description?.includes("CHAT_WRITE_FORBIDDEN")
    ) {
      return;
    }
    console.error("Message handler error:", err);
  }
});

// ---------- Launch ----------
bot.launch().then(() => {
  console.log(`🌸 ${WAIFU_NAME} bot is live!`);
  startScheduler(bot);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));