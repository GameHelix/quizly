-- The host can close a game to new players, as Kahoot's "Lock" does, once the
-- room is in, so nobody can flood it with made-up players mid-game.
alter table games add column locked boolean not null default false;
