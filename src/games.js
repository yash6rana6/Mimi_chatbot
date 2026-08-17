// SFW truth prompts - halka-fulka, embarrassing but appropriate
const TRUTHS = [
  'Tumhara sabse embarrassing moment kya tha?',
  'Kisi pe crush hai abhi?',
  'Sabse bada jhooth jo kisi se bola ho?',
  'Kabhi kisi ko secretly stalk kiya hai social media pe?',
  'Tumhara sabse bada dar kya hai?',
  'Kisi teacher/boss ke peeche kya bola tha kabhi?',
  'Last time kab roye the aur kyun?',
  'Sabse weird cheez jo tumne kabhi khayi ho?',
  'Kisi se jealous ho abhi tak?',
  'Tumhara guilty pleasure kya hai (koi show/song jo chhup ke dekhte/sunte ho)?',
  'Kabhi kisi test/exam mein cheat kiya hai?',
  'Sabse embarrassing text jo galti se galat person ko bhej diya ho?',
  'Agar ek din ke liye invisible ho sakte, kya karte?',
  'Sabse bada regret kya hai abhi tak?',
  'Kisi ke baare mein pehli impression galat nikli ho, kiske baare mein?',
];

const DARES = [
  'Apna current mood ek emoji mein bhejo, bas.',
  'Apni last 3 photos gallery se describe karo (bina dikhaye).',
  'Ek voice message bhejo gaana gaate hue (kuch bhi).',
  '30 second ke liye caps lock mein baat karo.',
  'Apna favorite dialogue kisi movie ka type karo dramatically.',
  'Group ke kisi member ko cute compliment do.',
  'Apni pichli 5 WhatsApp/Telegram chats ke naam batao (bina content ke).',
  'Ek joke sunao, chahe kitna bhi bura ho.',
  'Apna phone battery % aur last app use kiya wo batao.',
  '10 second ke liye sirf emojis mein baat karo.',
  'Apna go-to order kisi restaurant ka batao.',
  'Kisi ek group member ko roast karo (pyaar se).',
];

// Would You Rather - dono options SFW, fun dilemma
const WYR_QUESTIONS = [
  { a: 'Hamesha 10 minute late rehna', b: 'Hamesha 30 minute early pahunchna' },
  { a: 'Mind-reading power', b: 'Invisibility power' },
  { a: 'Bina internet ke ek mahina', b: 'Bina AC/pankhe ke ek mahina' },
  { a: 'Perfect memory', b: 'Perfect intuition' },
  { a: 'Famous hona lekin broke', b: 'Rich hona lekin unknown' },
  { a: 'Hamesha sach bolna majboori', b: 'Kabhi sach na bol sakna' },
  { a: 'Time travel sirf past mein', b: 'Time travel sirf future mein' },
  { a: 'Ek hi gaana zindagi bhar sunna', b: 'Kabhi gaana na sun pana' },
  { a: 'Loud snorer partner', b: 'Extremely messy partner' },
  { a: 'Har jagah teleport kar sako', b: 'Kisi bhi language mein fluent ho jao' },
];

// Relationship/general trivia quiz - multiple choice
const QUIZ_QUESTIONS = [
  {
    q: 'Valentine\'s Day kis date ko manaya jata hai?',
    options: ['Feb 14', 'Feb 20', 'March 8', 'Jan 14'],
    correct: 0,
  },
  {
    q: 'Kaunsa flower pyaar ka symbol maana jata hai?',
    options: ['Sunflower', 'Rose', 'Lily', 'Tulip'],
    correct: 1,
  },
  {
    q: '"Titanic" movie kis saal aayi thi?',
    options: ['1995', '1997', '2000', '1999'],
    correct: 1,
  },
  {
    q: 'Kaunsa planet "Red Planet" kehlata hai?',
    options: ['Venus', 'Jupiter', 'Mars', 'Saturn'],
    correct: 2,
  },
  {
    q: 'India ka national animal kaunsa hai?',
    options: ['Sher', 'Bagh (Tiger)', 'Hathi', 'Mor'],
    correct: 1,
  },
  {
    q: 'Kaunsa emoji "love at first sight" ke liye best fit hai?',
    options: ['❤️', '💘', '💕', '💔'],
    correct: 1,
  },
  {
    q: 'Ek couple ki "anniversary" kise kehte hain?',
    options: ['Birthday', 'Relationship ki shuruaat ka din', 'Random din', 'Job start date'],
    correct: 1,
  },
];

// Shuffle-bag system: har list ko pehle poora shuffle karke "bag" bana lete hain,
// use se ek-ek karke nikalte hain. Bag khali hone par dobara shuffle ho jata hai.
// Isse turant repeat nahi hota - saare questions ek baar aane ke baad hi dobara aayenge.
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

// Do naamon se deterministic (same naam pair = hamesha same %) lekin random-feel compatibility % nikalta hai
function calculateLoveCompatibility(name1, name2) {
  const combined = (name1 + name2).toLowerCase().split('').sort().join('');
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash << 5) - hash + combined.charCodeAt(i);
    hash |= 0;
  }
  const percent = Math.abs(hash) % 101;

  let message;
  if (percent >= 90) message = 'Perfect match! Made for each other 💞';
  else if (percent >= 70) message = 'Bohot strong connection hai ye! 💕';
  else if (percent >= 50) message = 'Achi possibility hai, thoda effort lagega 💗';
  else if (percent >= 30) message = 'Kaam chalau hai, dosti tak theek 😅';
  else message = 'Uff, thoda mushkil combo hai ye 💔';

  return { percent, message };
}

module.exports = {
  getRandomTruth,
  getRandomDare,
  getRandomWYR,
  getRandomQuiz,
  calculateLoveCompatibility,
};