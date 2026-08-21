const { callGemini } = require('./gemini');

const QUOTES = [
  'The biggest risk in life is not taking any risk.',
  'Every day is a new beginning, don\'t waste it.',
  'Success belongs to the one who gets back up after falling.',
  'Believe in yourself, everything else follows.',
  'Just try to become a little better today than yesterday.',
  'It\'s the small joys that make up a life.',
  'The one who moves forward despite fear is the one who wins.',
  'Comparison is the biggest thief of joy.',
  'Hard work is never wasted, it just takes time.',
  'Make your own path, don\'t just follow others\' footsteps.',
  'Your biggest enemy is your own self-doubt.',
  'Don\'t stop, even if the speed drops.',
  'Growth is hidden in the very thing that scares you.',
  'Patience and consistency together create miracles.',
  'A little effort today builds a big result tomorrow.',
];

const QOTD = [
  'If you could have one superpower, which would you pick and why?',
  'What\'s the best advice anyone has ever given you?',
  'If you could do anything for a day with no consequences, what would you do?',
  'What\'s the best decision you\'ve made in life so far?',
  'If you had a time machine, which year would you go to?',
  'What\'s one skill you want to learn but haven\'t yet?',
  'What\'s the most memorable trip/outing you\'ve had?',
  'If you could be a celebrity for a day, who would you be?',
  'How would you plan the perfect weekend (no restrictions)?',
  'What movie/show can you rewatch endlessly without getting bored?',
  'If you got a lifetime supply of one thing for free, what would you pick?',
  'What\'s the most underrated thing people don\'t appreciate enough?',
  'If you were invisible for a day, what would you do first?',
];

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const bags = new Map();

function drawFromBag(key, sourceArr) {
  let bag = bags.get(key);
  if (!bag || bag.length === 0) {
    bag = shuffle(sourceArr);
    bags.set(key, bag);
  }
  return bag.pop();
}

function getRandomQuote() {
  return drawFromBag('quote', QUOTES);
}

// Generates a fresh quote via Gemini so it's never the same repeated set.
// Falls back to the static list if the API call fails for any reason.
async function generateQuote() {
  try {
    const text = await callGemini(
      'You generate a single short, original motivational or witty one-liner quote (max 20 words). Reply with ONLY the quote text - no quotation marks, no attribution, no extra commentary.',
      [],
      'Give me a fresh quote.'
    );
    const clean = text?.trim().replace(/^["']|["']$/g, '');
    if (clean && clean.length > 0 && clean.length < 200) return clean;
  } catch (err) {
    console.error('Quote generation error:', err.message);
  }
  return getRandomQuote(); // fallback to the static list
}

function getRandomQOTD() {
  return drawFromBag('qotd', QOTD);
}

module.exports = { getRandomQuote, generateQuote, getRandomQOTD };