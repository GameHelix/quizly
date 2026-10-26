-- The quiz library and the games played from it.
-- Times that drive play (opens_at, deadline, answered_at) are epoch milliseconds,
-- the same numbers the server and the browsers count in.

create table quizzes (
  id text primary key,
  title text not null,
  settings jsonb not null,               -- questionsPerRound, secondsPerQuestion, scoring, shuffling
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table questions (
  quiz_id text not null references quizzes (id) on delete cascade,
  id text not null,
  position integer not null,
  category text not null,
  difficulty text not null,
  prompt text not null,
  options jsonb not null,                -- array of 2 to 6 strings
  answer integer not null,               -- index into options
  explanation text not null default '',
  updated_at timestamptz not null default now(),
  primary key (quiz_id, id)
);
create index questions_order on questions (quiz_id, position);

-- A game copies its title, settings and questions when it is created, so editing
-- or deleting the quiz afterwards changes neither the game nor its results.
create table games (
  id uuid primary key,
  pin text not null,
  quiz_id text references quizzes (id) on delete set null,
  title text not null,
  status text not null default 'lobby',  -- lobby | running | finished | abandoned
  phase text not null default 'lobby',   -- lobby | question | reveal | leaderboard | final
  current_index integer not null default -1,
  opens_at bigint,                       -- when the current question's options open
  deadline bigint,                       -- when its clock runs out
  join_url text not null,
  settings jsonb not null,
  round jsonb not null,                  -- the questions in play order, options as shown, answer re-indexed
  awards jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- A PIN is unique among games still being played; finished games release theirs.
create unique index games_live_pin on games (pin) where status in ('lobby', 'running');
create index games_pin on games (pin, created_at desc);
create index games_created on games (created_at desc);

-- Scores, streaks and ranks are banked here at each reveal, so every read is a lookup.
create table players (
  id uuid primary key,
  game_id uuid not null references games (id) on delete cascade,
  nickname text not null,
  avatar text not null,
  token_hash text not null,
  kicked boolean not null default false,
  joined_at bigint not null,
  score integer not null default 0,
  last_points integer not null default 0,
  streak integer not null default 0,
  best_streak integer not null default 0,
  correct_count integer not null default 0,
  correct_ms bigint not null default 0,
  rank integer,                          -- after the latest reveal
  prev_rank integer,                     -- after the one before
  ranks jsonb not null default '{}'      -- question index → rank after that reveal
);
create unique index players_nickname on players (game_id, lower(nickname)) where not kicked;
create index players_game on players (game_id);

create table answers (
  game_id uuid not null references games (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  question_index integer not null,
  choice integer not null,               -- index into the options as shown
  correct boolean not null,
  points integer not null,
  bonus integer not null,                -- the streak part of points
  elapsed_ms integer not null,
  answered_at bigint not null,
  primary key (player_id, question_index)
);
create index answers_game on answers (game_id, question_index);

-- Fixed-window counters for login attempts and PIN guesses. Serverless
-- instances share nothing in memory, so the count has to live here.
create table rate_limits (
  key text primary key,
  count integer not null,
  reset_at bigint not null
);
