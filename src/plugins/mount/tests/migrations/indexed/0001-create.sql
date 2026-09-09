CREATE TABLE seats (id TEXT PRIMARY KEY, email TEXT NOT NULL);

CREATE UNIQUE INDEX seats_email ON seats (email);
