/* An error whose message is safe to show the person who caused it. Anything
 * else that escapes a request handler is logged and reported as a plain 500. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* A game rule said no. The code travels to the browser with a status and a
 * sentence; the browser shows the sentence and acts on the code. */
export class GameError extends UserError {
  constructor(code) {
    const [status, message] = GAME_ERRORS[code] ?? [409, "That cannot be done right now."];
    super(message, status);
    this.code = code;
  }
}

const GAME_ERRORS = {
  no_game: [404, "No game with that PIN is running."],
  game_over: [409, "This game has finished."],
  game_full: [409, "This game is full."],
  game_locked: [409, "The host has closed this game to new players."],
  bad_nickname: [400, "Pick a nickname."],
  nickname_taken: [409, "Someone already has that nickname. Try another."],
  not_in_game: [401, "You are not in this game. Join again."],
  kicked: [403, "The host removed you from this game."],
  not_open: [409, "This question is closed."],
  not_open_yet: [409, "The options are not open yet."],
  too_late: [409, "Time is up for this question."],
  already_answered: [409, "You already answered this one."],
  bad_choice: [400, "That is not one of the options."],
  no_players: [409, "Nobody has joined yet."],
  no_player: [404, "That player is not in this game."],
  no_questions: [409, "That quiz has no questions to play."],
  no_pin: [503, "Could not find a free PIN. Try again."],
  slow_down: [429, "Too many attempts. Wait a few minutes and try again."]
};

/* One line per event on stdout, which is what Vercel and any container platform collect. */
export const log = {
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields)
};

function write(level, msg, fields = {}) {
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${v instanceof Error ? JSON.stringify(v.stack || v.message) : JSON.stringify(v)}`)
    .join(" ");
  const line = `${new Date().toISOString()} ${level} ${msg}${extra ? " " + extra : ""}`;
  (level === "error" ? console.error : console.log)(line);
}
