const MONTHS: Record<string, { label: string; value: number }> = {
  january: { label: "January", value: 1 },
  february: { label: "February", value: 2 },
  march: { label: "March", value: 3 },
  april: { label: "April", value: 4 },
  may: { label: "May", value: 5 },
  june: { label: "June", value: 6 },
  july: { label: "July", value: 7 },
  august: { label: "August", value: 8 },
  september: { label: "September", value: 9 },
  october: { label: "October", value: 10 },
  november: { label: "November", value: 11 },
  december: { label: "December", value: 12 }
};

const DAY_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  eleventh: 11,
  twelve: 12,
  twelfth: 12,
  thirteen: 13,
  thirteenth: 13,
  fourteen: 14,
  fourteenth: 14,
  fifteen: 15,
  fifteenth: 15,
  sixteen: 16,
  sixteenth: 16,
  seventeen: 17,
  seventeenth: 17,
  eighteen: 18,
  eighteenth: 18,
  nineteen: 19,
  nineteenth: 19,
  twenty: 20,
  twentieth: 20,
  thirty: 30,
  thirtieth: 30
};

const YEAR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};

interface Token {
  text: string;
  index: number;
}

interface DateMatch {
  display: string;
  key: string;
  start: number;
  end: number;
}

export function normalizeReadableTranscript(value: string): string {
  const matches = findSpokenDateMatches(value);

  return matches
    .slice()
    .reverse()
    .reduce(
      (result, match) =>
        `${result.slice(0, match.start)}${match.display}${result.slice(match.end)}`,
      value
    );
}


function findSpokenDateMatches(value: string): DateMatch[] {
  const tokens = tokenize(value);
  const matches: DateMatch[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const month = MONTHS[normalizeToken(tokens[index].text)];

    if (!month) {
      continue;
    }

    const dayResult = parseDay(tokens, index + 1);

    if (!dayResult) {
      continue;
    }

    const yearResult = parseYear(tokens, dayResult.nextIndex);

    if (!yearResult) {
      continue;
    }

    const endToken = tokens[yearResult.nextIndex - 1];
    matches.push({
      display: `${month.label} ${dayResult.day}, ${yearResult.year}`,
      key: toDateKey(yearResult.year, month.value, dayResult.day),
      start: tokens[index].index,
      end: endToken.index + endToken.text.length
    });

    index = yearResult.nextIndex - 1;
  }

  return matches;
}

function tokenize(value: string): Token[] {
  return Array.from(value.matchAll(/[A-Za-z]+|\d{1,4}(?:st|nd|rd|th)?/g)).map(
    (match) => ({
      text: match[0],
      index: match.index ?? 0
    })
  );
}

function parseDay(
  tokens: Token[],
  index: number
): { day: number; nextIndex: number } | undefined {
  const current = tokens[index];

  if (!current) {
    return undefined;
  }

  const numericDay = parseOrdinalNumber(current.text);

  if (numericDay !== undefined && numericDay >= 1 && numericDay <= 31) {
    return { day: numericDay, nextIndex: index + 1 };
  }

  const firstWord = normalizeToken(current.text);
  const singleWordDay = DAY_WORDS[firstWord];

  if (singleWordDay !== undefined && singleWordDay >= 1 && singleWordDay <= 31) {
    return { day: singleWordDay, nextIndex: index + 1 };
  }

  if (firstWord === "twenty" || firstWord === "thirty") {
    const secondWord = normalizeToken(tokens[index + 1]?.text ?? "");
    const secondWordDay = DAY_WORDS[secondWord];

    if (secondWordDay !== undefined && secondWordDay < 10) {
      return {
        day: DAY_WORDS[firstWord] + secondWordDay,
        nextIndex: index + 2
      };
    }
  }

  return undefined;
}

function parseYear(
  tokens: Token[],
  index: number
): { year: number; nextIndex: number } | undefined {
  const current = tokens[index];

  if (!current) {
    return undefined;
  }

  const numericYear = parseOrdinalNumber(current.text);

  if (numericYear !== undefined && numericYear >= 1000) {
    return { year: numericYear, nextIndex: index + 1 };
  }

  const firstWord = normalizeToken(current.text);
  const secondWord = normalizeToken(tokens[index + 1]?.text ?? "");

  if (firstWord === "two" && secondWord === "thousand") {
    const tail = parseTwoDigitNumber(tokens, index + 2);
    return {
      year: 2000 + (tail?.value ?? 0),
      nextIndex: tail?.nextIndex ?? index + 2
    };
  }

  if (firstWord === "nineteen" || firstWord === "twenty") {
    const tail = parseTwoDigitNumber(tokens, index + 1);

    if (tail) {
      return {
        year: (firstWord === "nineteen" ? 1900 : 2000) + tail.value,
        nextIndex: tail.nextIndex
      };
    }
  }

  return undefined;
}

function parseTwoDigitNumber(
  tokens: Token[],
  index: number
): { value: number; nextIndex: number } | undefined {
  const firstWord = normalizeToken(tokens[index]?.text ?? "");
  const firstValue = YEAR_WORDS[firstWord];

  if (firstValue === undefined) {
    return undefined;
  }

  if (firstValue < 20) {
    return { value: firstValue, nextIndex: index + 1 };
  }

  const secondWord = normalizeToken(tokens[index + 1]?.text ?? "");
  const secondValue = YEAR_WORDS[secondWord];

  if (secondValue !== undefined && secondValue < 10) {
    return { value: firstValue + secondValue, nextIndex: index + 2 };
  }

  return { value: firstValue, nextIndex: index + 1 };
}

function parseOrdinalNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value.replace(/(?:st|nd|rd|th)$/i, ""), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeToken(value: string): string {
  return value.toLowerCase();
}

function toDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
