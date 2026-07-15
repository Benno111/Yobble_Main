export const BAD_WORDS = [
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "crap",
  "cunt",
  "damn",
  "dick",
  "fuck",
  "motherfucker",
  "nigga",
  "nigger",
  "piss",
  "prick",
  "shit",
  "slut",
  "twat",
  "wanker"
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBlockedWordPattern() {
  const variants = BAD_WORDS.map((word) => {
    const looseWord = word.split("").map(escapeRegExp).join("[\\W_]*");
    return `${looseWord}[a-z0-9]{0,16}`;
  });
  return new RegExp(`(^|[^a-z0-9])(${variants.join("|")})(?=$|[^a-z0-9])`, "gi");
}

const blockedWordPattern = buildBlockedWordPattern();

export function censorText(value) {
  if (!value) return "";
  blockedWordPattern.lastIndex = 0;
  return String(value).replace(blockedWordPattern, (match, prefix, word) => {
    return `${prefix}${"*".repeat(word.length)}`;
  });
}

export function hasBlockedWord(value) {
  if (!value) return false;
  blockedWordPattern.lastIndex = 0;
  return blockedWordPattern.test(String(value));
}
