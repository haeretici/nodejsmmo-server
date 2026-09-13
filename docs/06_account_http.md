# 06. Account HTTP

S1 surface. Same process as the tick. Passwords never go on the game socket.

## Do not

- Generic login error that reveals whether the email exists (`invalid_credentials`).
- Hash before cheap rejects (IP ban, lockout, rate limit).
- Trust `X-Forwarded-For` unless `trustedProxy`.
- Auto-login brute: per-account `locked_until` + per-IP refuse.

## Routes

| Method | Path | Auth |
| :--- | :--- | :--- |
| GET | `/health` | no |
| GET | `/ready` | no (MySQL ping + tick) |
| GET | `/debug` | no (`debugPlayPage`; loopback click client) |
| POST | `/v1/register` | `{ email, password }` → session cookie |
| POST | `/v1/login` | `{ email, password }` → session cookie |
| POST | `/v1/logout` | cookie |
| GET | `/v1/me` | cookie |
| GET | `/v1/characters` | cookie |
| POST | `/v1/characters` | `{ name, vocation }` |
| DELETE | `/v1/characters/:id` | cookie |
| POST | `/v1/play` | `{ characterId }` → `{ token, expiresAt }` |

Session cookie: `sid` httpOnly, SameSite=Lax, raw 32 bytes hex. DB stores SHA-256 only.

Play token: 32 bytes, SHA-256 at rest, TTL `playTokenTtlSec` (45), one unused token per character. S2 `ENTER` consumes it (`consumePlayToken`). Reuse → `BAD_TOKEN`.

## Limits (settings)

| Knob | Default |
| :--- | ---: |
| JSON body | 16384 |
| HTTP / IP / min | 60 (`/health` `/ready` exempt) |
| Account fails → lock | 8; 30 s × 2^n, cap 900 s |
| IP fails / 10 min | 20 → refuse 600 s |
| Sockets / IP | 8 |
| Chars / account | 4 |
| Password | 10–128 chars |
| Name | 3–20, `^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$` |

Argon2 on a dummy hash when the email is missing (timing). Dummy verify is **after** lockout/IP refuse.

## Key files

`src/http/handler.js` `src/http/account.js` `src/http/server.js` `src/security/rate_limit.js`

S6: public pages live in `../frontend`. That process proxies `/v1/*` (not `/v1/ws`) so the `sid` cookie is same-origin on the site. The game socket is still this process.
