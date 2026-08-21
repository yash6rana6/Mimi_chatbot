// SFW truth prompts - light-hearted, embarrassing but appropriate
const TRUTHS = [
  'What was your most embarrassing moment?',
  'Do you have a crush on someone right now?',
  'What\'s the biggest lie you\'ve told someone?',
  'Have you ever secretly stalked someone on social media?',
  'What\'s your biggest fear?',
  'What did you say behind a teacher\'s/boss\'s back once?',
  'When did you last cry and why?',
  'What\'s the weirdest thing you\'ve ever eaten?',
  'Are you jealous of someone right now?',
  'What\'s your guilty pleasure (a show/song you watch/listen to secretly)?',
  'Have you ever cheated on a test/exam?',
  'What\'s the most embarrassing text you\'ve sent to the wrong person?',
  'If you could be invisible for a day, what would you do?',
  'What\'s your biggest regret so far?',
  'Whose first impression turned out completely wrong?',
  'What\'s the most childish thing you still do?',
  'Have you ever lied to get out of a plan?',
  'What\'s the most awkward date you\'ve been on?',
  'Do you still have a childhood stuffed toy?',
  'What\'s the worst advice you\'ve ever given?',
];

const DARES = [
  'Send your current mood as just one emoji.',
  'Describe your last 3 gallery photos (without showing them).',
  'Send a voice message singing a song (any song).',
  'Talk in caps lock for 30 seconds.',
  'Type out your favorite movie dialogue dramatically.',
  'Give a group member a cute compliment.',
  'Name your last 5 WhatsApp/Telegram chats (without revealing content).',
  'Tell a joke, no matter how bad.',
  'Share your phone battery % and the last app you used.',
  'Talk only in emojis for 10 seconds.',
  'Share your go-to order at a restaurant.',
  'Roast a group member (lovingly).',
  'Send a selfie with a funny filter.',
  'Do 10 pushups and send a voice note of you breathing heavily.',
  'Speak in a British accent for the next 3 messages.',
  'Send your most used emoji and explain why.',
  'Share your screen time from yesterday.',
  'Type a message with your eyes closed.',
];

// Would You Rather - both options SFW, fun dilemma
const WYR_QUESTIONS = [
  { a: 'Always be 10 minutes late', b: 'Always arrive 30 minutes early' },
  { a: 'Mind-reading power', b: 'Invisibility power' },
  { a: 'A month with no internet', b: 'A month with no AC/fan' },
  { a: 'Perfect memory', b: 'Perfect intuition' },
  { a: 'Be famous but broke', b: 'Be rich but unknown' },
  { a: 'Be forced to always tell the truth', b: 'Never be able to tell the truth' },
  { a: 'Time travel only to the past', b: 'Time travel only to the future' },
  { a: 'Listen to one song for the rest of your life', b: 'Never listen to music again' },
  { a: 'A loud-snoring partner', b: 'An extremely messy partner' },
  { a: 'Be able to teleport anywhere', b: 'Be fluent in any language instantly' },
  { a: 'Have a superpower but only work at night', b: 'Have no power but be rich' },
  { a: 'Never use social media again', b: 'Never watch movies/TV again' },
];

// Relationship/general trivia quiz - multiple choice
const QUIZ_QUESTIONS = [
  {
    q: '💘 What date is Valentine\'s Day celebrated on?',
    options: ['Feb 14', 'Feb 20', 'March 8', 'Jan 14'],
    correct: 0,
    funFact: 'Valentine\'s Day is named after Saint Valentine!'
  },
  {
    q: '🌹 Which flower is considered the symbol of love?',
    options: ['Sunflower', 'Rose', 'Lily', 'Tulip'],
    correct: 1,
    funFact: 'A red rose means "I love you" in flower language!'
  },
  {
    q: '🎬 What year did the movie "Titanic" release?',
    options: ['1995', '1997', '2000', '1999'],
    correct: 1,
    funFact: 'Titanic was the first movie to gross over $1 billion!'
  },
  {
    q: '🪐 Which planet is called the "Red Planet"?',
    options: ['Venus', 'Jupiter', 'Mars', 'Saturn'],
    correct: 2,
    funFact: 'Mars gets its red color from iron oxide (rust)!'
  },
  {
    q: '🐯 What is India\'s national animal?',
    options: ['Lion', 'Tiger', 'Elephant', 'Peacock'],
    correct: 1,
    funFact: 'The Bengal Tiger is India\'s national animal!'
  },
  {
    q: '💕 Which emoji best fits "love at first sight"?',
    options: ['❤️', '💘', '💕', '💔'],
    correct: 1,
    funFact: '💘 is the "heart with arrow" emoji - cupid\'s arrow!'
  },
  {
    q: '📅 What do you call the day a couple started their relationship?',
    options: ['Birthday', 'Anniversary', 'Random day', 'Job start date'],
    correct: 1,
    funFact: 'Anniversary comes from Latin "annus" (year)!'
  },
  {
    q: '🎨 What color symbolizes love in many cultures?',
    options: ['Blue', 'Red', 'Green', 'Yellow'],
    correct: 1,
    funFact: 'Red symbolizes passion and love in most cultures!'
  },
  {
    q: '🍫 What is the most popular gift on Valentine\'s Day?',
    options: ['Flowers', 'Chocolates', 'Teddy Bear', 'Perfume'],
    correct: 1,
    funFact: 'Over 58 million pounds of chocolate are sold on Valentine\'s Day!'
  },
  {
    q: '💑 Which Greek god is associated with love?',
    options: ['Zeus', 'Eros', 'Apollo', 'Ares'],
    correct: 1,
    funFact: 'Eros is the Greek god of love and desire!'
  },
];

// Shuffle-bag system: shuffle the whole list into a "bag" first, then draw
// items one by one. When the bag empties, it gets reshuffled.
// This avoids immediate repeats - every item shows once before any repeats.
const bags = new Map();

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function drawFromBag(key, sourceArr) {
  let bag = bags.get(key);
  if (!bag || bag.length === 0) {
    bag = shuffle(sourceArr);
    bags.set(key, bag);
  }
  return bag.pop();
}

function getRandomTruth() {
  return drawFromBag('truth', TRUTHS);
}

function getRandomDare() {
  return drawFromBag('dare', DARES);
}

function getRandomWYR() {
  return drawFromBag('wyr', WYR_QUESTIONS);
}

function getRandomQuiz() {
  return drawFromBag('quiz', QUIZ_QUESTIONS);
}

// Computes a deterministic (same name pair = always same %) but random-feeling compatibility % from two names
function calculateLoveCompatibility(name1, name2) {
  const combined = (name1 + name2).toLowerCase().split('').sort().join('');
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0;
  }
  const percent = Math.abs(hash) % 101;

  let message;
  if (percent >= 90) message = '🌟 Perfect match! Made for each other 💞';
  else if (percent >= 70) message = '💕 This is a really strong connection!';
  else if (percent >= 50) message = '💗 Good possibility, will take some effort';
  else if (percent >= 30) message = '😅 It\'s workable, good as friends';
  else message = '💔 Ooof, tough combo this one';

  return { percent, message };
}

module.exports = {
  getRandomTruth,
  getRandomDare,
  getRandomWYR,
  getRandomQuiz,
  calculateLoveCompatibility,
};